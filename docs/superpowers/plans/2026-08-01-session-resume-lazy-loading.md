# Session Resume 懒加载 Implementation Plan（v2 修正版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** resume 超大 session 时，compaction 边界前的巨型 message 条目不全量 `JSON.parse`，改为 peek 元数据 + 按需 materialize；对所有解引用 `.message` 的访问点加 guard 使 lazy 占位不崩。消除加载阶段卡死，不改文件格式、保留 revert。

**Architecture:** `loadEntriesFromFile` 两阶段——流式读时大行只 peek 存 `PendingEntry`（含 offset、不保留 raw），读完后据最后一个 compaction 的 offset 决策：offset < compaction 的大行转 `LazyEntry`（compaction 前），offset >= 的从磁盘 readRawLine full parse（活跃）。所有 `.message` 解引用点（buildSessionContext/_persist/createBranchedSession/footer/usage-totals/cache-stats）用 optional chaining 加 guard。compaction entry 新增 `cumulativeUsage` 让 footer 累计 token 不依赖逐个 parse。

**Tech Stack:** TypeScript（严格，禁止 `any`/inline import/erasable syntax 违规）、vitest、`node:fs` 同步 API、`@earendil-works/pi-ai/compat` 的 `Usage`。

**Spec:** `docs/superpowers/specs/2026-08-01-session-resume-lazy-loading-design.md`（v2）

## Global Constraints

- 禁止 `any`；禁止 inline import；禁止 erasable syntax 违规。
- **内容零丢失**：regex peek 取不到 → fallback full parse。
- `LAZY_ENTRY_THRESHOLD = 64 * 1024`（64KB）。
- 字段顺序：`SessionMessageEntry` 序列化时 `type/id/parentId/timestamp` 先于 `message`（peek 依赖）——固化注释 + 测试。
- coding-agent 测试：`npx vitest run --dir packages/coding-agent/test <pattern>`。
- 每 task 结束跑 `npm run check`（完整输出）。
- commit 显式路径 `git add <paths>`，禁止 `git add -A`/`.`。

---

## Task 1: LazyEntry + 边界感知 loadEntriesFromFile + materialize

**Files:**

- Modify: `packages/coding-agent/src/core/session-manager.ts`（`LazyEntry`、`PendingEntry`、`LAZY_ENTRY_THRESHOLD`、`peekEntryFields`、`readRawLine`；改造 `loadEntriesFromFile` 两阶段；`SessionManager.materialize`）
- Test: `packages/coding-agent/test/session-manager/lazy-loading.test.ts`

**Interfaces:**

- Produces:
  - `export interface LazyEntry` — `{ type:"message"; id; parentId; timestamp; readonly __lazy:true; offset; length }`
  - `export interface PendingEntry` — 两阶段中间态 `{ type:"message"; id; parentId; timestamp; offset; length }`（exported for testing）
  - `export const LAZY_ENTRY_THRESHOLD = 64*1024`
  - `export function peekEntryFields(line): {type?;id?;parentId?}` — regex；取不到返回 undefined（fallback full parse）
  - `export function readRawLine(filePath, offset, length): string`
  - `SessionManager.materialize(id): SessionEntry | undefined`
- Consumes: `loadEntriesFromFile(filePath): FileEntry[]` 签名不变（返回值含 LazyEntry 变体）

- [ ] **Step 1: 写失败测试 — peek + 边界决策**

创建 `packages/coding-agent/test/session-manager/lazy-loading.test.ts`：

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
 LAZY_ENTRY_THRESHOLD,
 loadEntriesFromFile,
 peekEntryFields,
 SessionManager,
} from "../../src/core/session-manager.ts";

function makeHeader(): string {
 return JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" });
}
function makeMsg(id: string, parentId: string | null, bytes: number, role = "toolResult"): string {
 return JSON.stringify({
  type: "message", id, parentId, timestamp: "2026-08-01T00:00:00.000Z",
  message: { role, content: [{ type: "text", text: "x".repeat(Math.max(0, bytes)) }] },
 });
}
function makeCompaction(id: string, firstKept: string): string {
 return JSON.stringify({ type: "compaction", id, parentId: null, timestamp: "2026-08-01T00:00:00.000Z", summary: "s", firstKeptEntryId: firstKept, tokensBefore: 1000 });
}

describe("peekEntryFields", () => {
 it("extracts type/id/parentId without full parse", () => {
  const line = makeMsg("abc", "p1", 10);
  const f = peekEntryFields(line);
  expect(f.type).toBe("message");
  expect(f.id).toBe("abc");
  expect(f.parentId).toBe("p1");
 });
});

describe("loadEntriesFromFile boundary-aware lazy", () => {
 it("compaction-前大行 → LazyEntry", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, `${makeHeader()}\n${makeMsg("big1", null, LAZY_ENTRY_THRESHOLD + 1000)}\n${makeCompaction("c1", "big1")}\n${makeMsg("after", "c1", 50)}\n`);
  const entries = loadEntriesFromFile(file);
  const big1 = entries.find((e) => (e as { id?: string }).id === "big1") as { __lazy?: boolean; message?: unknown };
  expect(big1.__lazy).toBe(true);
  expect(big1.message).toBeUndefined();
 });

 it("compaction-后大行 → full parse（活跃）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, `${makeHeader()}\n${makeCompaction("c1", "h")}\n${makeMsg("big2", "c1", LAZY_ENTRY_THRESHOLD + 1000)}\n`);
  const entries = loadEntriesFromFile(file);
  const big2 = entries.find((e) => (e as { id?: string }).id === "big2") as { __lazy?: boolean; message?: unknown };
  expect(big2.__lazy).not.toBe(true);
  expect(big2.message).toBeDefined(); // 已 full parse
 });

 it("无 compaction 大行 → full parse（零回归）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, `${makeHeader()}\n${makeMsg("big3", null, LAZY_ENTRY_THRESHOLD + 1000)}\n`);
  const entries = loadEntriesFromFile(file);
  const big3 = entries.find((e) => (e as { id?: string }).id === "big3") as { __lazy?: boolean; message?: unknown };
  expect(big3.__lazy).not.toBe(true);
  expect(big3.message).toBeDefined();
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-loading`
Expected: FAIL — `peekEntryFields`/`LAZY_ENTRY_THRESHOLD` 未导出，大行仍 full parse。

- [ ] **Step 3: 实现类型 + 常量 + peek + readRawLine**

在 `session-manager.ts`（`SessionEntry` 类型定义附近）新增：

```typescript
/** 字节阈值：超过此长度的 message 行加载时不全量 parse。 */
export const LAZY_ENTRY_THRESHOLD = 64 * 1024;

/** 两阶段加载的中间态：大行只 peek 元数据，读完后据 compaction offset 决策。 */
export interface PendingEntry {
 type: "message";
 id: string;
 parentId: string | null;
 timestamp: string;
 offset: number;
 length: number;
}

/**
 * compaction 前、超阈值 message 条目的内存占位。仅元数据 + 磁盘偏移；
 * 访问 .message 前必须 materialize。字段顺序依赖 type/id/parentId/timestamp
 * 在序列化时位于 message 之前（peekEntryFields regex 依赖）。
 */
export interface LazyEntry {
 type: "message";
 id: string;
 parentId: string | null;
 timestamp: string;
 readonly __lazy: true;
 offset: number;
 length: number;
}

/** Regex peek 顶层字段（不全量 parse）。取不到返回 undefined 字段，调用方 fallback full parse。 */
export function peekEntryFields(line: string): { type?: string; id?: string; parentId?: string | null } {
 const type = line.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
 const id = line.match(/"id"\s*:\s*"([^"]+)"/)?.[1];
 const pm = line.match(/"parentId"\s*:\s*(?:"([^"]+)"|null)/);
 return { type, id, parentId: pm ? (pm[1] ?? null) : undefined };
}

/** 从文件 offset 读 length 字节返回 utf8（materialize / lazy 序列化复用）。 */
export function readRawLine(filePath: string, offset: number, length: number): string {
 const fd = openSync(filePath, "r");
 try {
  const buf = Buffer.allocUnsafe(length);
  const n = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n).toString("utf8");
 } finally {
  closeSync(fd);
 }
}
```

- [ ] **Step 4: 改造 loadEntriesFromFile — 两阶段边界感知**

替换现有 `loadEntriesFromFile`（509-551）：

```typescript
/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
 const resolvedFilePath = normalizePath(filePath);
 if (!existsSync(resolvedFilePath)) return [];

 // 第一阶段：流式读。小行 full parse；大行 peek 存 PendingEntry（不保留 raw，省内存）；
 // 记录最后一个 compaction 行的 offset。
 const slots: Array<FileEntry | PendingEntry> = [];
 let lastCompactionOffset = Number.POSITIVE_INFINITY;
 const fd = openSync(resolvedFilePath, "r");
 try {
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
  let pending = "";
  let consumedBytes = 0; // 单一字节游标：已完整消费的字节数（含行尾 \n）

  const handleLine = (line: string): void => {
   if (!line.trim()) return;
   const offset = consumedBytes;
   const byteLen = Buffer.byteLength(line, "utf8");
   consumedBytes += byteLen + 1; // +1 for \n
   if (byteLen > LAZY_ENTRY_THRESHOLD) {
    const f = peekEntryFields(line);
    if (f.type === "message" && f.id !== undefined && f.parentId !== undefined) {
     slots.push({ type: "message", id: f.id, parentId: f.parentId, timestamp: line.match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1] ?? "", offset, length: byteLen });
     return;
    }
    // peek 失败 → fallback full parse（零丢失）
   }
   const entry = parseSessionEntryLine(line);
   if (entry) {
    slots.push(entry);
    if (entry.type === "compaction") lastCompactionOffset = offset;
   }
  };

  while (true) {
   const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
   if (bytesRead === 0) break;
   pending += decoder.write(buffer.subarray(0, bytesRead));
   let lineStart = 0;
   let nl = pending.indexOf("\n", lineStart);
   while (nl !== -1) {
    handleLine(pending.slice(lineStart, nl));
    lineStart = nl + 1;
    nl = pending.indexOf("\n", lineStart);
   }
   pending = pending.slice(lineStart);
  }
  pending += decoder.end();
  if (pending.trim()) handleLine(pending);
 } finally {
  closeSync(fd);
 }

 // 第二阶段：据 lastCompactionOffset 决策 pending。
 // offset < lastCompactionOffset（compaction 前）→ LazyEntry；
 // 否则（活跃，含无 compaction 的全部）→ readRawLine full parse。
 const entries: FileEntry[] = [];
 for (const slot of slots) {
  if ((slot as { __lazy?: boolean }).__lazy || (slot as PendingEntry).offset !== undefined && !("message" in slot)) {
   // PendingEntry：无 message 字段
   const p = slot as PendingEntry;
   if (p.offset < lastCompactionOffset) {
    entries.push({ type: "message", id: p.id, parentId: p.parentId, timestamp: p.timestamp, __lazy: true, offset: p.offset, length: p.length } as unknown as FileEntry);
   } else {
    const raw = readRawLine(resolvedFilePath, p.offset, p.length);
    const full = parseSessionEntryLine(raw);
    if (full) entries.push(full);
   }
  } else {
   entries.push(slot as FileEntry);
  }
 }

 if (entries.length === 0) return entries;
 const header = entries[0];
 if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") return [];
 return entries;
}
```

> **实现注意**：上面第二阶段的 PendingEntry 判定用 `offset !== undefined && !("message" in slot)`。PendingEntry 无 `message` 字段、有 `offset`；full parse 的 FileEntry 有 `message`（message entry）或无 `offset`。若边界判定有歧义，改为给 PendingEntry 加显式标记字段 `__pending: true` 更稳——implementer 据实际类型清晰度决定，并在注释固化。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-loading`
Expected: PASS（compaction 前 lazy / 后 full / 无 compaction full）。

- [ ] **Step 6: 写失败测试 — materialize**

```typescript
describe("SessionManager.materialize", () => {
 it("restores full content from lazy placeholder", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const file = join(dir, "s.jsonl");
  const big = makeMsg("bigM", null, LAZY_ENTRY_THRESHOLD + 500);
  writeFileSync(file, `${makeHeader()}\n${big}\n${makeCompaction("c1", "bigM")}\n`);
  const sm = SessionManager.create("/tmp", dir);
  sm.setSessionFile(file);
  expect((sm.getEntry("bigM") as { __lazy?: boolean }).__lazy).toBe(true);
  const m = sm.materialize("bigM");
  expect(m).toBeDefined();
  expect((m as { message: { content: unknown[] } }).message.content).toEqual(JSON.parse(big).message.content);
  expect((sm.getEntry("bigM") as { __lazy?: boolean }).__lazy).not.toBe(true);
 });
});
```

- [ ] **Step 7: 运行确认失败 → 实现 materialize → 确认通过**

实现（`SessionManager` 类内 `loadSubagentRunEntries` 附近）：

```typescript
 materialize(id: string): SessionEntry | undefined {
  const entry = this.byId.get(id);
  if (!entry) return undefined;
  if (!(entry as { __lazy?: boolean }).__lazy) return entry;
  if (!this.sessionFile) return entry;
  const lazy = entry as unknown as LazyEntry;
  const raw = readRawLine(this.sessionFile, lazy.offset, lazy.length);
  const full = parseSessionEntryLine(raw);
  if (!full) return entry;
  this.byId.set(id, full);
  const idx = this.fileEntries.findIndex((e) => (e as { id?: string }).id === id && (e as { __lazy?: boolean }).__lazy);
  if (idx !== -1) this.fileEntries[idx] = full;
  return full;
 }
```

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-loading` → PASS。

- [ ] **Step 8: 回归 + check + commit**

```bash
npx vitest run --dir packages/coding-agent/test session-manager
npx vitest run --dir packages/coding-agent/test compaction
npm run check
git add packages/coding-agent/src/core/session-manager.ts packages/coding-agent/test/session-manager/lazy-loading.test.ts
git commit -m "feat(session): boundary-aware lazy load of pre-compaction oversized messages"
```

---

## Task 2: `.message` 解引用点 guard（optional chaining）

LazyEntry 无 `.message`，所有解引用点用 optional chaining 加 guard。

**Files:**

- Modify: `packages/coding-agent/src/core/session-manager.ts`（`buildSessionContext` settings 循环 445 + appendMessage 462；`_persist` hasAssistant 1003；`createBranchedSession` hasAssistant 1639）
- Modify: `packages/coding-agent/src/core/usage-totals.ts`（43-48）
- Modify: `packages/coding-agent/src/core/cache-stats.ts`（120）
- Test: `packages/coding-agent/test/session-manager/lazy-guard.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `LazyEntry`、`SessionManager.materialize`

- [ ] **Step 1: 写失败测试 — buildSessionContext 遇 lazy 不崩**

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAZY_ENTRY_THRESHOLD, SessionManager, buildSessionContext } from "../../src/core/session-manager.ts";

function makeHeader(): string {
 return JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" });
}
function makeMsg(id: string, parentId: string | null, bytes: number): string {
 return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-08-01T00:00:00.000Z", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "x".repeat(bytes) }] } });
}
function makeCompaction(id: string, firstKept: string): string {
 return JSON.stringify({ type: "compaction", id, parentId: null, timestamp: "2026-08-01T00:00:00.000Z", summary: "s", firstKeptEntryId: firstKept, tokensBefore: 1000 });
}

describe("lazy guard — no crash on .message deref", () => {
 it("buildSessionContext does not throw on lazy placeholders", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const file = join(dir, "s.jsonl");
  // 大 toolResult 在 compaction 前 → lazy；compaction 后有正常 assistant/user
  writeFileSync(file, `${makeHeader()}\n${makeMsg("big", null, LAZY_ENTRY_THRESHOLD + 1000)}\n${makeCompaction("c1", "big")}\n${makeMsg("after", "c1", 50, "user")}\n`);
  const sm = SessionManager.create("/tmp", dir);
  sm.setSessionFile(file);
  expect(() => sm.buildSessionContext()).not.toThrow();
 });

 it("_persist does not throw after resume with lazy entries (append a message)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, `${makeHeader()}\n${makeMsg("big", null, LAZY_ENTRY_THRESHOLD + 1000)}\n${makeCompaction("c1", "big")}\n`);
  const sm = SessionManager.create("/tmp", dir);
  sm.setSessionFile(file);
  // resume 后首次 append 触发 _persist hasAssistant
  expect(() => sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }] } as never)).not.toThrow();
 });
});
```

（`makeMsg` 的 role 参数化：补一个 `role = "toolResult"` 默认参数，同 Task 1。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-guard`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'role')`。

- [ ] **Step 3: 加 guard（session-manager.ts 4 处）**

- `buildSessionContext` settings 循环（约 445）：`entry.message.role` → `entry.message?.role`
- `buildSessionContext` appendMessage（约 462）：`if (entry.type === "message")` → `if (entry.type === "message" && entry.message)`
- `_persist`（1003）：`e.message.role` → `e.message?.role`
- `createBranchedSession`（1639）：`e.message.role` → `e.message?.role`

> 语义安全：LazyEntry 是 toolResult（非 assistant），optional chaining 使其被跳过；assistant 通常 <64KB 不 lazy，故 hasAssistant 仍能正确识别真正的 assistant。

- [ ] **Step 4: 加 guard（usage-totals.ts / cache-stats.ts）**

grep 这两个文件所有 `.message.role` / `.message.usage` 解引用，改为 optional chaining（遇 lazy 跳过，累计/统计不含 compaction 前细节——可接受）。

- [ ] **Step 5: 运行确认通过 + 回归**

```bash
npx vitest run --dir packages/coding-agent/test session-manager
npm run check
```

Expected: lazy-guard PASS；session-manager 全过。

- [ ] **Step 6: commit**

```bash
git add packages/coding-agent/src/core/session-manager.ts packages/coding-agent/src/core/usage-totals.ts packages/coding-agent/src/core/cache-stats.ts packages/coding-agent/test/session-manager/lazy-guard.test.ts
git commit -m "fix(session): guard .message deref sites against lazy entries (optional chaining)"
```

---

## Task 3: `_rewriteFile` + `forkFrom` lazy 原样写回

LazyEntry 不能 `JSON.stringify`（丢 message）。rewrite/fork 从源文件 offset 读 raw 原样写回。

**Files:**

- Modify: `packages/coding-agent/src/core/session-manager.ts`（`_rewriteFile`、`forkFrom`；私有 `_writeEntryRaw`）
- Test: `packages/coding-agent/test/session-manager/lazy-rewrite.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `LazyEntry`、`readRawLine`

- [ ] **Step 1: 写失败测试 — prune 后 lazy 内容保留**

```typescript
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAZY_ENTRY_THRESHOLD, SessionManager } from "../../src/core/session-manager.ts";
// makeHeader/makeMsg/makeCompaction 同前

describe("_rewriteFile preserves lazy content", () => {
 it("keeps oversized message intact after prune", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rw-"));
  const file = join(dir, "s.jsonl");
  const big = makeMsg("big1", null, LAZY_ENTRY_THRESHOLD + 2000);
  writeFileSync(file, `${makeHeader()}\n${big}\n${makeCompaction("c1", "big1")}\n${makeMsg("m2", "c1", 50)}\n`);
  const sm = SessionManager.create("/tmp", dir);
  sm.setSessionFile(file);
  expect((sm.getEntry("big1") as { __lazy?: boolean }).__lazy).toBe(true);
  sm.pruneOrphanedEntries(sm.getLeafId());
  const rewritten = readFileSync(file, "utf8");
  expect(rewritten).toContain('"id":"big1"');
  expect(rewritten.length).toBeGreaterThan(LAZY_ENTRY_THRESHOLD);
 });
});
```

- [ ] **Step 2: 运行确认失败 → 实现 → 确认通过**

新增私有辅助 + 改造 `_rewriteFile`：

```typescript
 private _writeEntryRaw(fd: number, entry: FileEntry, newOffset: number): number {
  if ((entry as { __lazy?: boolean }).__lazy && this.sessionFile) {
   const lazy = entry as unknown as LazyEntry;
   const raw = readRawLine(this.sessionFile, lazy.offset, lazy.length);
   writeFileSync(fd, `${raw}\n`);
   lazy.offset = newOffset;
   return lazy.length + 1;
  }
  const line = `${JSON.stringify(entry)}\n`;
  writeFileSync(fd, line);
  return Buffer.byteLength(line, "utf8");
 }

 private _rewriteFile(): void {
  if (!this.persist || !this.sessionFile) return;
  const fd = openSync(this.sessionFile, "w");
  try {
   let offset = 0;
   for (const entry of this.fileEntries) offset += this._writeEntryRaw(fd, entry, offset);
  } finally {
   closeSync(fd);
  }
 }
```

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-rewrite` → PASS。

- [ ] **Step 3: 写失败测试 — forkFrom 保留 lazy → 实现 → 通过**

`forkFrom`（约 1780）"Copy all non-header entries" 循环改为：

```typescript
  const fdOut = openSync(newSessionFile, "a");
  try {
   for (const entry of sourceEntries) {
    if (entry.type === "session") continue;
    if ((entry as { __lazy?: boolean }).__lazy) {
     const lazy = entry as unknown as LazyEntry;
     appendFileSync(fdOut, `${readRawLine(resolvedSourcePath, lazy.offset, lazy.length)}\n`);
    } else {
     appendFileSync(fdOut, `${JSON.stringify(entry)}\n`);
    }
   }
  } finally {
   closeSync(fdOut);
  }
```

- [ ] **Step 4: 回归 + check + commit**

```bash
npx vitest run --dir packages/coding-agent/test session-manager
npx vitest run --dir packages/coding-agent/test sdk-session-manager
npm run check
git add packages/coding-agent/src/core/session-manager.ts packages/coding-agent/test/session-manager/lazy-rewrite.test.ts
git commit -m "fix(session): preserve lazy entry content in rewrite/fork (raw passthrough)"
```

---

## Task 4: compaction `cumulativeUsage` + footer 累计 usage

footer 遍历所有 entries 累加 usage 是热路径。compaction entry 携带累计 usage，footer 以最后一个 compaction 作基线 + 累加其后，跳过 lazy 占位。

**Files:**

- Modify: `packages/coding-agent/src/core/session-manager.ts`（`CompactionEntry.cumulativeUsage`；`appendCompaction` 计算；模块级 `sumEntriesUsage`）
- Modify: `packages/coding-agent/src/modes/interactive/components/footer.ts`（`computeFooterUsage`）
- Test: `packages/coding-agent/test/session-manager/compaction-cumulative-usage.test.ts`、`packages/coding-agent/test/footer-cumulative-usage.test.ts`

- [ ] **Step 1: 写失败测试 — appendCompaction 写入 cumulativeUsage**

```typescript
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Usage } from "@earendil-works/pi-ai/compat";
function makeUsage(input: number, output: number): Usage {
 return { input, output, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
describe("appendCompaction cumulativeUsage", () => {
 it("records cumulative usage of all prior entries", () => {
  const sm = SessionManager.inMemory();
  sm.newSession();
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "a" }], provider: "p", model: "m", api: "anthropic-messages", usage: makeUsage(30, 5), stopReason: "end", timestamp: 0 } as never);
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "b" }], provider: "p", model: "m", api: "anthropic-messages", usage: makeUsage(40, 8), stopReason: "end", timestamp: 0 } as never);
  const leaf = sm.getLeafId()!;
  const cid = sm.appendCompaction("sum", leaf, 1000);
  expect((sm.getEntry(cid) as { cumulativeUsage?: Usage }).cumulativeUsage?.input).toBe(70);
 });
});
```

- [ ] **Step 2: 运行确认失败 → 实现 → 通过**

`CompactionEntry` 加 `cumulativeUsage?: Usage`；模块级 `sumEntriesUsage`（遍历 fileEntries 累加 message.usage + branch_summary/compaction.usage，嵌套 compaction 用其 cumulativeUsage）；`appendCompaction` 末尾 `cumulativeUsage = sumEntriesUsage(this.fileEntries)` 写入 entry。

Run: `npx vitest run --dir packages/coding-agent/test session-manager/compaction-cumulative-usage` → PASS。

- [ ] **Step 3: 写失败测试 — footer computeFooterUsage 用 cumulativeUsage 基线**

构造 entries（含带 cumulativeUsage 的 compaction + 其后条目），断言 `computeFooterUsage` 输出 = cumulativeUsage + 其后 usage，不依赖 compaction 前 lazy 占位。

- [ ] **Step 4: 实现 footer computeFooterUsage → 通过**

`footer.ts` 抽出 `export function computeFooterUsage(entries)`：找最后一个带 `cumulativeUsage` 的 compaction 作基线，累加其后条目；render 中累计块替换为调用它。

- [ ] **Step 5: 回归 + check + commit**

```bash
npx vitest run --dir packages/coding-agent/test session-manager
npx vitest run --dir packages/coding-agent/test footer
npm run check
git add packages/coding-agent/src/core/session-manager.ts packages/coding-agent/src/modes/interactive/components/footer.ts packages/coding-agent/test/session-manager/compaction-cumulative-usage.test.ts packages/coding-agent/test/footer-cumulative-usage.test.ts
git commit -m "feat(footer): use compaction cumulativeUsage, skip pre-compaction lazy entries"
```

---

## Self-Review

**Spec coverage:** 边界感知 lazy（Task 1）✅；LazyEntry/materialize（Task 1）✅；全 `.message` guard（Task 2: buildSessionContext/_persist/createBranchedSession/usage-totals/cache-stats）✅；_rewriteFile/forkFrom lazy raw（Task 3）✅；footer cumulativeUsage（Task 4）✅；peek fallback（Task 1 parseLineLazy）✅；字段顺序注释（Task 1）✅；无 compaction 零回归（Task 1 测试）✅。

**Type consistency:** `LazyEntry`/`PendingEntry`/`peekEntryFields`/`readRawLine`/`materialize`/`sumEntriesUsage`/`computeFooterUsage`/`cumulativeUsage` 跨 task 引用一致。

**依赖顺序:** Task 1（LazyEntry 基础）→ Task 2/3（消费 LazyEntry）→ Task 4（compaction + footer，独立于 lazy 但消费其概念）。Task 2/3 可并行依赖 Task 1。
