# Session Resume 懒加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** resume 超大 session 时，compaction 边界前的巨型 message 条目不全量 `JSON.parse`，改为 peek 元数据 + 按需 materialize，消除加载阶段卡死。

**Architecture:** `loadEntriesFromFile` 流式读取时对超阈值（默认 64KB）的大行只 regex peek 顶层字段（type/id/parentId），存为 `LazyEntry` 占位（含磁盘 offset/length）；`buildSessionContext` 走 leaf→root 不碰 compaction 前 lazy 占位，故 resume→渲染主路径零 materialize；仅在 revert/getBranch 深入 compaction 前、fork/rewrite 持久化时按 offset 读 raw 回填。compaction entry 新增 `cumulativeUsage` 让 footer 累计 token 不依赖逐个 parse compaction 前条目。

**Tech Stack:** TypeScript（严格，禁止 `any`/inline import/erasable syntax 违规）、vitest、`node:fs` 同步 API、`@earendil-works/pi-ai/compat` 的 `Usage` 类型。

**Spec:** `docs/superpowers/specs/2026-08-01-session-resume-lazy-loading-design.md`

## Global Constraints

- 禁止 `any`；禁止 inline import（`await import()`）；禁止 erasable syntax 违规（参数属性/enum/namespace）。
- **内容零丢失**：regex peek 取不到元数据时 **fallback full parse**，绝不跳过。
- 阈值常量 `LAZY_ENTRY_THRESHOLD = 64 * 1024`（64KB）。
- 字段顺序约束：`SessionMessageEntry` 序列化时 `type/id/parentId/timestamp` 必须位于 `message` 之前（regex peek 依赖此）——固化注释 + 测试防回归。
- coding-agent 测试 runner：`npx vitest run --dir packages/coding-agent/test <pattern>`（vitest，`describe/it/expect` from "vitest"）。
- 每个 task 结束跑 `npm run check`（必须完整输出，不 tail）。
- commit 用显式路径 `git add <paths>`，禁止 `git add -A`/`.`。

---

## Task 1: LazyEntry + loadEntriesFromFile 懒加载 + materialize

**Files:**

- Modify: `packages/coding-agent/src/core/session-manager.ts`（新增 `LazyEntry` 类型、`LAZY_ENTRY_THRESHOLD`、`peekEntryFields`、`readRawLine`；改造 `loadEntriesFromFile`；新增 `SessionManager.materialize`）
- Test: `packages/coding-agent/test/session-manager/lazy-loading.test.ts`

**Interfaces:**

- Produces:
  - `export interface LazyEntry` — `{ type: "message"; id: string; parentId: string | null; timestamp: string; __lazy: true; offset: number; length: number }`
  - `export const LAZY_ENTRY_THRESHOLD: number` = 64KB
  - `function peekEntryFields(line: string): { type?: string; id?: string; parentId?: string | null }` — regex 提取，取不到返回 undefined（调用方 fallback full parse）
  - `function readRawLine(filePath: string, offset: number, length: number): string` — seek 读 length 字节返回 utf8 字符串
  - `SessionManager.materialize(id: string): SessionEntry | undefined` — lazy 占位按 offset 读 raw + parse + 替换 byId/fileEntries，返回完整 entry；非 lazy 直接返回
- Consumes: `loadEntriesFromFile` 现有签名 `(filePath: string): FileEntry[]` 不变（返回值含 LazyEntry 变体）

- [ ] **Step 1: 写失败测试 — peek 与阈值判定**

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

// 构造一行合法的 message entry JSON，text 部分填充到指定字节数
function makeMessageLine(id: string, parentId: string | null, textBytes: number): string {
 const filler = "x".repeat(Math.max(0, textBytes));
 const entry = {
  type: "message",
  id,
  parentId,
  timestamp: "2026-08-01T00:00:00.000Z",
  message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: filler }] },
 };
 return JSON.stringify(entry);
}

function makeHeader(): string {
 return JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" });
}

describe("peekEntryFields", () => {
 it("extracts type/id/parentId without full parse", () => {
  const line = makeMessageLine("abc123", "parent1", 10);
  const fields = peekEntryFields(line);
  expect(fields.type).toBe("message");
  expect(fields.id).toBe("abc123");
  expect(fields.parentId).toBe("parent1");
 });

 it("returns undefined when fields missing (malformed)", () => {
  const fields = peekEntryFields('{"foo":"bar"}');
  expect(fields.type).toBeUndefined();
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-loading`
Expected: FAIL — `peekEntryFields` / `LAZY_ENTRY_THRESHOLD` 未导出。

- [ ] **Step 3: 实现 LazyEntry 类型 + 常量 + peek 函数 + readRawLine**

在 `session-manager.ts` 顶部 import 后、`SessionEntry` 类型定义附近新增：

```typescript
/** 字节阈值：超过此长度的 message 行在加载时不全量 JSON.parse，存为 LazyEntry。 */
export const LAZY_ENTRY_THRESHOLD = 64 * 1024;

/**
 * Compaction 边界之前、体积超 LAZY_ENTRY_THRESHOLD 的 message 条目的内存占位。
 * 仅保留树遍历所需元数据 + 磁盘偏移；访问 .message 前必须 materialize。
 *
 * 字段顺序约束：依赖 SessionMessageEntry 序列化时 type/id/parentId/timestamp
 * 位于 message 之前（peekEntryFields 用 regex 提取，不全量 parse）。
 */
export interface LazyEntry {
 type: "message";
 id: string;
 parentId: string | null;
 timestamp: string;
 readonly __lazy: true;
 /** 在 sessionFile 中的字节偏移 */
 offset: number;
 /** 该行字节长度 */
 length: number;
}

/** Regex peek 顶层字段，不全量 JSON.parse。取不到返回 undefined 字段（调用方 fallback full parse）。 */
export function peekEntryFields(line: string): { type?: string; id?: string; parentId?: string | null } {
 const type = line.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
 const id = line.match(/"id"\s*:\s*"([^"]+)"/)?.[1];
 const pidMatch = line.match(/"parentId"\s*:\s*(?:"([^"]+)"|null)/);
 return { type, id, parentId: pidMatch ? (pidMatch[1] ?? null) : undefined };
}

/** 从文件指定偏移读 length 字节，返回 utf8 字符串（materialize / lazy 序列化复用）。 */
export function readRawLine(filePath: string, offset: number, length: number): string {
 const fd = openSync(filePath, "r");
 try {
  const buf = Buffer.allocUnsafe(length);
  const bytesRead = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, bytesRead).toString("utf8");
 } finally {
  closeSync(fd);
 }
}
```

- [ ] **Step 4: 写失败测试 — loadEntriesFromFile 大行 lazy、小行 parse**

在 lazy-loading.test.ts 追加：

```typescript
describe("loadEntriesFromFile lazy loading", () => {
 it("parses small message lines normally", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, `${makeHeader()}\n${makeMessageLine("m1", null, 100)}\n`);
  const entries = loadEntriesFromFile(file);
  const msg = entries.find((e) => (e as { id?: string }).id === "m1");
  expect(msg).toBeDefined();
  expect((msg as { __lazy?: boolean }).__lazy).not.toBe(true);
 });

 it("stores large message lines as LazyEntry (no message content parsed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const file = join(dir, "s.jsonl");
  const big = makeMessageLine("big1", null, LAZY_ENTRY_THRESHOLD + 1000);
  writeFileSync(file, `${makeHeader()}\n${big}\n`);
  const entries = loadEntriesFromFile(file);
  const bigEntry = entries.find((e) => (e as { id?: string }).id === "big1") as
   | (typeof entries)[number]
   | undefined;
  expect(bigEntry).toBeDefined();
  // LazyEntry 标记 + 元数据完整 + 无 message 内容
  expect((bigEntry as { __lazy?: boolean }).__lazy).toBe(true);
  expect((bigEntry as { id?: string }).id).toBe("big1");
  expect((bigEntry as { parentId?: string | null }).parentId).toBeNull();
  expect((bigEntry as { message?: unknown }).message).toBeUndefined();
  expect((bigEntry as { offset?: number }).offset).toBeGreaterThan(0);
  expect((bigEntry as { length?: number }).length).toBe(big.length);
 });
});
```

- [ ] **Step 5: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-loading`
Expected: FAIL — 大行仍被 full parse（无 `__lazy`）。

- [ ] **Step 6: 改造 loadEntriesFromFile — 流式 peek + lazy**

将现有 `loadEntriesFromFile`（509-551 行）的逐行解析改为：记录每行字节 offset，超阈值且能 peek 出 type=id=message 的行存 LazyEntry，否则 fallback full parse。替换 `parseSessionEntryLine(pending.slice(...))` 处的逻辑：

```typescript
/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
 const resolvedFilePath = normalizePath(filePath);
 if (!existsSync(resolvedFilePath)) return [];

 const entries: FileEntry[] = [];
 const fd = openSync(resolvedFilePath, "r");
 try {
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
  let pending = "";
  let fileOffset = 0; // 已读字节游标

  while (true) {
   const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
   if (bytesRead === 0) break;

   pending += decoder.write(buffer.subarray(0, bytesRead));
   let lineStart = 0;
   let newlineIndex = pending.indexOf("\n", lineStart);
   while (newlineIndex !== -1) {
    const lineBytes = pending.slice(lineStart, newlineIndex);
    // lineStart/fileOffset 都是基于已读 pending 的字节游标；line 字节长度不含末尾 \n
    const entryOffset = fileOffset + Buffer.byteLength(pending.slice(0, lineStart), "utf8");
    entries.push(parseLineLazy(resolvedFilePath, lineBytes, entryOffset));
    fileOffset = entryOffset + Buffer.byteLength(lineBytes, "utf8") + 1; // +1 for \n
    lineStart = newlineIndex + 1;
    newlineIndex = pending.indexOf("\n", lineStart);
   }
   pending = pending.slice(lineStart);
   // 注意：slice 后 fileOffset 语义需基于"已消费字节"。改用累计 consumedBytes 更稳：
  }

  pending += decoder.end();
  // 最后一行（无尾换行）
  // 见下方 Step 说明：fileOffset 已正确累计
  const finalEntry = parseLineLazy(resolvedFilePath, pending, fileOffset);
  if (finalEntry) entries.push(finalEntry);
 } finally {
  closeSync(fd);
 }

 // Validate session header
 if (entries.length === 0) return entries;
 const header = entries[0];
 if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
  return [];
 }
 return entries;
}
```

> **实现注意（重要）：** 上面 `fileOffset` 累计在 `pending = pending.slice(lineStart)` 后会错乱（pending 缩短但 fileOffset 逻辑混淆）。**实际实现改用单一 `consumedBytes` 计数器**：每次完整消费一行（含 `\n`），`consumedBytes += Buffer.byteLength(该行+'\n')`；每行的 entry offset = consume 这行前的 `consumedBytes`。不要混合 pending 字符串游标与字节游标。`parseLineLazy` 的 offset 参数即该行起始字节偏移。

新增 `parseLineLazy`（私有辅助，紧跟 `parseSessionEntryLine` 之后）：

```typescript
/**
 * 解析单行：超 LAZY_ENTRY_THRESHOLD 且为 message 行 → LazyEntry（peek 元数据，不全量 parse）。
 * 否则 full parse（含 peek 失败的 fallback，保证零丢失）。
 * filePath 仅记录到 LazyEntry 供 materialize 时复用路径推断（SessionManager 持有 sessionFile）。
 */
function parseLineLazy(filePath: string, line: string, offset: number): FileEntry | null {
 if (!line.trim()) return null;
 const byteLen = Buffer.byteLength(line, "utf8");
 if (byteLen > LAZY_ENTRY_THRESHOLD) {
  const fields = peekEntryFields(line);
  if (fields.type === "message" && fields.id !== undefined && fields.parentId !== undefined) {
   const lazy: LazyEntry = {
    type: "message",
    id: fields.id,
    parentId: fields.parentId,
    timestamp: line.match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1] ?? "",
    __lazy: true,
    offset,
    length: byteLen,
   };
   return lazy as unknown as FileEntry;
  }
  // peek 失败 → fallback full parse（零丢失）
 }
 return parseSessionEntryLine(line);
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-loading`
Expected: PASS — 小行 normal、大行 lazy。

- [ ] **Step 8: 写失败测试 — materialize 还原完整内容**

```typescript
describe("SessionManager.materialize", () => {
 it("restores full message content from lazy placeholder", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const file = join(dir, "s.jsonl");
  const big = makeMessageLine("big2", null, LAZY_ENTRY_THRESHOLD + 500);
  writeFileSync(file, `${makeHeader()}\n${big}\n`);
  const sm = SessionManager.create("/tmp", dir);
  sm.setSessionFile(file);
  const entry = sm.getEntry("big2") as { __lazy?: boolean; message?: unknown };
  expect(entry.__lazy).toBe(true);
  expect(entry.message).toBeUndefined();
  const materialized = sm.materialize("big2");
  expect(materialized).toBeDefined();
  // materialize 后内容与原始 full parse 逐字段一致
  const full = JSON.parse(big);
  expect((materialized as { message: { content: unknown[] } }).message.content).toEqual(full.message.content);
  // byId 已替换为完整 entry
  expect((sm.getEntry("big2") as { __lazy?: boolean }).__lazy).not.toBe(true);
 });

 it("returns entry unchanged when not lazy", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, `${makeHeader()}\n${makeMessageLine("small1", null, 50)}\n`);
  const sm = SessionManager.create("/tmp", dir);
  sm.setSessionFile(file);
  const before = sm.getEntry("small1");
  const after = sm.materialize("small1");
  expect(after).toBe(before);
 });
});
```

- [ ] **Step 9: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-loading`
Expected: FAIL — `materialize` 未定义。

- [ ] **Step 10: 实现 SessionManager.materialize**

在 `SessionManager` 类内（`loadSubagentRunEntries` 附近）新增：

```typescript
 /**
  * 若 id 对应 LazyEntry，从磁盘 offset 读 raw 行 full parse，替换 byId/fileEntries 中的占位，
  * 返回完整 SessionEntry。非 lazy 直接返回原 entry。找不到返回 undefined。
  */
 materialize(id: string): SessionEntry | undefined {
  const entry = this.byId.get(id);
  if (!entry) return undefined;
  if (!(entry as { __lazy?: boolean }).__lazy) return entry;
  if (!this.sessionFile) return entry;
  const lazy = entry as unknown as LazyEntry;
  const raw = readRawLine(this.sessionFile, lazy.offset, lazy.length);
  const full = parseSessionEntryLine(raw);
  if (!full) return entry; // 解析失败保守返回占位（零丢失：不破坏原状）
  // 替换 byId
  this.byId.set(id, full);
  // 替换 fileEntries 中同位置的占位
  const idx = this.fileEntries.findIndex((e) => (e as { id?: string }).id === id && (e as { __lazy?: boolean }).__lazy);
  if (idx !== -1) this.fileEntries[idx] = full;
  return full;
 }
```

- [ ] **Step 11: 运行测试确认通过 + 回归**

```bash
npx vitest run --dir packages/coding-agent/test session-manager
npx vitest run --dir packages/coding-agent/test compaction
```

Expected: lazy-loading PASS；session-manager / compaction 全过（小文件无 lazy，行为不变）。

- [ ] **Step 12: 跑 check + commit**

```bash
npm run check
git add packages/coding-agent/src/core/session-manager.ts packages/coding-agent/test/session-manager/lazy-loading.test.ts
git commit -m "feat(session): lazy-load oversized message entries on resume (M2)"
```

---

## Task 2: lazy 序列化正确性（_rewriteFile + forkFrom）

LazyEntry 不能 `JSON.stringify`（会丢 message 内容）。`_rewriteFile` 与 `forkFrom` 必须从源文件 offset 读 raw 原样写回。

**Files:**

- Modify: `packages/coding-agent/src/core/session-manager.ts`（`_rewriteFile`、`forkFrom`；新增私有 `appendEntryRaw` 辅助）
- Test: `packages/coding-agent/test/session-manager/lazy-rewrite.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `LazyEntry`、`readRawLine`
- Produces: `_rewriteFile` 与 `forkFrom` 对 lazy 占位从磁盘 raw 写回，并更新占位 offset

- [ ] **Step 1: 写失败测试 — prune 后 lazy 内容保留**

创建 `packages/coding-agent/test/session-manager/lazy-rewrite.test.ts`：

```typescript
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAZY_ENTRY_THRESHOLD, SessionManager } from "../../src/core/session-manager.ts";

function makeHeader(): string {
 return JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" });
}
function makeMsg(id: string, parentId: string | null, n: number): string {
 return JSON.stringify({
  type: "message", id, parentId, timestamp: "2026-08-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: "x".repeat(n) }] },
 });
}

describe("_rewriteFile preserves lazy content", () => {
 it("keeps oversized message intact after prune-triggered rewrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rewrite-"));
  const file = join(dir, "s.jsonl");
  const big = makeMsg("big1", null, LAZY_ENTRY_THRESHOLD + 2000);
  writeFileSync(file, `${makeHeader()}\n${big}\n${makeMsg("m2", null, 50)}\n`);
  const sm = SessionManager.create("/tmp", dir);
  sm.setSessionFile(file);
  expect((sm.getEntry("big1") as { __lazy?: boolean }).__lazy).toBe(true);
  // materialize 验证内容正确，然后 prune（触发 _rewriteFile）
  sm.materialize("big1");
  sm.pruneOrphanedEntries(sm.getLeafId());
  // 重新读文件：big1 行内容应原样保留（raw 回写）
  const rewritten = readFileSync(file, "utf8");
  expect(rewritten).toContain('"id":"big1"');
  expect(rewritten.length).toBeGreaterThan(LAZY_ENTRY_THRESHOLD); // 大内容未丢失
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-rewrite`
Expected: FAIL — rewrite 后 big1 内容丢失（LazyEntry 被 JSON.stringify 成无 message 的残缺对象）。

- [ ] **Step 3: 改造 _rewriteFile — lazy 原样写回 + 更新 offset**

新增私有辅助 + 改造 `_rewriteFile`：

```typescript
 /** 序列化单条 entry 写入 fd。LazyEntry 从 sessionFile offset 读 raw 原样写回；返回该行新 offset。 */
 private _writeEntryRaw(fd: number, entry: FileEntry, newOffset: number): number {
  const isLazy = (entry as { __lazy?: boolean }).__lazy;
  if (isLazy && this.sessionFile) {
   const lazy = entry as unknown as LazyEntry;
   const raw = readRawLine(this.sessionFile, lazy.offset, lazy.length);
   writeFileSync(fd, `${raw}\n`);
   // 更新占位 offset 指向新文件位置（保持 lazy 身份，下次仍可 materialize）
   lazy.offset = newOffset;
   return lazy.length + 1; // +1 for \n
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
   for (const entry of this.fileEntries) {
    offset += this._writeEntryRaw(fd, entry, offset);
   }
  } finally {
   closeSync(fd);
  }
 }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-rewrite`
Expected: PASS。

- [ ] **Step 5: 写失败测试 — forkFrom 保留 source lazy 内容**

```typescript
describe("forkFrom preserves lazy content", () => {
 it("copies oversized messages raw from source", () => {
  const srcDir = mkdtempSync(join(tmpdir(), "pi-fork-src-"));
  const src = join(srcDir, "s.jsonl");
  const big = makeMsg("bigfork", null, LAZY_ENTRY_THRESHOLD + 1500);
  writeFileSync(src, `${makeHeader()}\n${big}\n`);
  const targetDir = mkdtempSync(join(tmpdir(), "pi-fork-dst-"));
  const forked = SessionManager.forkFrom(src, "/tmp", targetDir);
  // fork 后目标文件应含完整 bigfork 内容
  const forkedFile = forked.getSessionFile()!;
  const content = readFileSync(forkedFile, "utf8");
  expect(content).toContain('"id":"bigfork"');
  expect(content.length).toBeGreaterThan(LAZY_ENTRY_THRESHOLD);
 });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/lazy-rewrite`
Expected: FAIL — fork 后 bigfork 残缺（`JSON.stringify(LazyEntry)` 丢 message）。

- [ ] **Step 7: 改造 forkFrom — source lazy 原样复制**

`forkFrom` 中 "Copy all non-header entries from source" 循环（约 1780 行）改为：

```typescript
  // Copy all non-header entries from source; lazy placeholders copied raw from source file
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

（替换原 `for ... appendFileSync(newSessionFile, JSON.stringify(entry))` 块。）

- [ ] **Step 8: 运行测试确认通过 + 回归**

```bash
npx vitest run --dir packages/coding-agent/test session-manager
npx vitest run --dir packages/coding-agent/test sdk-session-manager
```

Expected: 全过。

- [ ] **Step 9: 跑 check + commit**

```bash
npm run check
git add packages/coding-agent/src/core/session-manager.ts packages/coding-agent/test/session-manager/lazy-rewrite.test.ts
git commit -m "fix(session): preserve lazy entry content in rewrite/fork (raw passthrough)"
```

---

## Task 3: compaction cumulativeUsage + footer 累计 usage

footer 遍历所有 entries 累加 usage，是唯一触碰 compaction 前 lazy 占位 `.message` 的热路径。让 compaction entry 携带"截至 compaction 的累计 usage"，footer 以最后一个 compaction 的 cumulativeUsage 作基线 + 累加其后，跳过 compaction 前 lazy 占位。

**Files:**

- Modify: `packages/coding-agent/src/core/session-manager.ts`（`CompactionEntry` 加 `cumulativeUsage?`；`appendCompaction` 内部计算）
- Modify: `packages/coding-agent/src/modes/interactive/components/footer.ts`（usage 累计逻辑）
- Test: `packages/coding-agent/test/session-manager/compaction-cumulative-usage.test.ts`
- Test: 既有 footer 相关测试（如存在）回归

**Interfaces:**

- Consumes: `Usage` from `@earendil-works/pi-ai/compat`
- Produces: `CompactionEntry.cumulativeUsage?: Usage`；footer 不再逐个读 compaction 前 lazy 占位的 `.message.usage`

- [ ] **Step 1: 写失败测试 — appendCompaction 写入 cumulativeUsage**

创建 `packages/coding-agent/test/session-manager/compaction-cumulative-usage.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Usage } from "@earendil-works/pi-ai/compat";

function makeUsage(input: number, output: number): Usage {
 return {
  input, output, cacheRead: 0, cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
 };
}

describe("appendCompaction cumulativeUsage", () => {
 it("records cumulative usage of all prior entries", () => {
  const sm = SessionManager.inMemory();
  sm.newSession();
  // 两条带 usage 的 assistant message（累计 input=30+40=70）
  sm.appendMessage({
   role: "assistant", content: [{ type: "text", text: "hi" }],
   provider: "p", model: "m", api: "anthropic-messages",
   usage: makeUsage(30, 5), stopReason: "end", timestamp: 0,
  } as never);
  sm.appendMessage({
   role: "assistant", content: [{ type: "text", text: "yo" }],
   provider: "p", model: "m", api: "anthropic-messages",
   usage: makeUsage(40, 8), stopReason: "end", timestamp: 0,
  } as never);
  const leaf = sm.getLeafId()!;
  const cid = sm.appendCompaction("summary", leaf, 1000);
  const compaction = sm.getEntry(cid) as { cumulativeUsage?: Usage };
  expect(compaction.cumulativeUsage).toBeDefined();
  expect(compaction.cumulativeUsage!.input).toBe(70);
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/compaction-cumulative-usage`
Expected: FAIL — `cumulativeUsage` undefined。

- [ ] **Step 3: 给 CompactionEntry 加字段 + appendCompaction 计算**

`CompactionEntry` 接口加字段：

```typescript
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
 type: "compaction";
 summary: string;
 firstKeptEntryId: string;
 tokensBefore: number;
 details?: T;
 usage?: Usage;
 fromHook?: boolean;
 /** 截至 compaction 时所有已有 entries 的累计 usage（footer 基线，避免逐个 parse compaction 前 lazy 占位）。 */
 cumulativeUsage?: Usage;
}
```

`appendCompaction` 末尾构造 entry 前，计算累计：

```typescript
 appendCompaction<T = unknown>(
  summary: string,
  firstKeptEntryId: string,
  tokensBefore: number,
  details?: T,
  fromHook?: boolean,
  usage?: Usage,
 ): string {
  const cumulativeUsage = sumEntriesUsage(this.fileEntries);
  const entry: CompactionEntry<T> = {
   type: "compaction",
   id: generateId(this.byId),
   parentId: this.leafId,
   timestamp: new Date().toISOString(),
   summary,
   firstKeptEntryId,
   tokensBefore,
   details,
   usage,
   fromHook,
   cumulativeUsage,
  };
  this._appendEntry(entry);
  return entry.id;
 }
```

新增模块级辅助 `sumEntriesUsage`（与 `getLatestCompactionEntry` 同区）：

```typescript
/** 累加 entries 中所有 usage（message 的 message.usage + branch_summary/compaction 的 usage）。 */
function sumEntriesUsage(entries: FileEntry[]): Usage | undefined {
 let found = false;
 const total: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
 };
 for (const entry of entries) {
  let usage: Usage | undefined;
  if (entry.type === "message") {
   usage = (entry as { message?: { usage?: Usage } }).message?.usage;
  } else if (entry.type === "branch_summary" || entry.type === "compaction") {
   usage = (entry as { usage?: Usage }).usage;
   if (entry.type === "compaction") {
    // 嵌套 compaction：用其 cumulativeUsage 一次性含其前累计，避免重复
    const cu = (entry as { cumulativeUsage?: Usage }).cumulativeUsage;
    if (cu) usage = cu;
   }
  }
  if (usage) {
   found = true;
   total.input += usage.input ?? 0;
   total.output += usage.output ?? 0;
   total.cacheRead += usage.cacheRead ?? 0;
   total.cacheWrite += usage.cacheWrite ?? 0;
   if (usage.cost) {
    total.cost.total += usage.cost.total ?? 0;
   }
  }
 }
 return found ? total : undefined;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run --dir packages/coding-agent/test session-manager/compaction-cumulative-usage`
Expected: PASS。

- [ ] **Step 5: 写失败测试 — footer 用 cumulativeUsage 基线**

在 footer 测试中（若无既有测试，新建 `packages/coding-agent/test/footer-cumulative-usage.test.ts`）验证：当存在带 cumulativeUsage 的 compaction 时，footer 累计 = cumulativeUsage + compaction 之后 usage，不依赖 compaction 前 lazy 占位。测试以 SessionManager 构造含 lazy 占位 + compaction 的 session，断言 footer 渲染的累计 input 值。

（具体断言依赖 footer 测试 harness；若项目无 footer 单元测试 harness，则改为：构造 session，验证一个等价的纯函数 `computeCumulativeUsage(entries)` 输出正确——将该逻辑从 footer 抽出为可测函数 `computeFooterUsage(entries): Usage`。）

- [ ] **Step 6: 运行测试确认失败**

Run: 对应 footer/usage 测试
Expected: FAIL。

- [ ] **Step 7: 改造 footer usage 累计逻辑**

在 `footer.ts` 抽出可测函数 `computeFooterUsage`，render 中调用：

```typescript
/** 计算累计 usage：以最后一个带 cumulativeUsage 的 compaction 为基线，累加其后条目。 */
export function computeFooterUsage(entries: SessionEntryLike[]): {
 totalInput: number; totalOutput: number; totalCacheRead: number; totalCacheWrite: number; totalCost: number;
} {
 let lastCompactionIdx = -1;
 let baseline: Usage | undefined;
 for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  if (e.type === "compaction" && (e as { cumulativeUsage?: Usage }).cumulativeUsage) {
   lastCompactionIdx = i;
   baseline = (e as { cumulativeUsage?: Usage }).cumulativeUsage;
  }
 }
 const start: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } = baseline
  ? { input: baseline.input, output: baseline.output, cacheRead: baseline.cacheRead, cacheWrite: baseline.cacheWrite, cost: baseline.cost.total }
  : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
 // 从 lastCompactionIdx 之后（或全部，若无 compaction）累加
 for (let i = lastCompactionIdx + 1; i < entries.length; i++) {
  const e = entries[i];
  const usage = readEntryUsage(e);
  if (usage) {
   start.input += usage.input ?? 0;
   start.output += usage.output ?? 0;
   start.cacheRead += usage.cacheRead ?? 0;
   start.cacheWrite += usage.cacheWrite ?? 0;
   start.cost += usage.cost?.total ?? 0;
  }
 }
 return { totalInput: start.input, totalOutput: start.output, totalCacheRead: start.cacheRead, totalCacheWrite: start.cacheWrite, totalCost: start.cost };
}
```

`readEntryUsage` / `SessionEntryLike` 为 footer 内的轻量类型（沿用 footer 现有遍历里对 message/compaction/branch_summary 的 usage 提取逻辑，抽出函数）。render 中 `for (const entry of ...)` 累计块替换为 `const { totalInput, ... } = computeFooterUsage(entries)`。

- [ ] **Step 8: 运行测试确认通过 + 回归**

```bash
npx vitest run --dir packages/coding-agent/test session-manager
npx vitest run --dir packages/coding-agent/test footer
```

Expected: 全过。

- [ ] **Step 9: 跑 check + commit**

```bash
npm run check
git add packages/coding-agent/src/core/session-manager.ts packages/coding-agent/src/modes/interactive/components/footer.ts packages/coding-agent/test/session-manager/compaction-cumulative-usage.test.ts packages/coding-agent/test/footer-cumulative-usage.test.ts
git commit -m "feat(footer): use compaction cumulativeUsage to avoid touching pre-compaction lazy entries"
```

---

## Self-Review

**Spec coverage:**

- 懒加载读取（loadEntriesFromFile peek+lazy）→ Task 1 ✅
- LazyEntry 结构 → Task 1 ✅
- materialize + 触发点（getBranch/getEntry 调用方按需）→ Task 1 materialize + Task 2 rewrite/fork ✅
- buildSessionContext 不触发（验证为测试）→ Task 1 Step 11 回归覆盖（compaction/buildSessionContext 测试不破）✅
- footer cumulativeUsage（方案 B）→ Task 3 ✅
- _rewriteFile lazy raw 写回 → Task 2 ✅
- forkFrom lazy（调用面发现）→ Task 2 ✅
- peek 稳健性 + fallback → Task 1 peekEntryFields 返回 undefined 时 parseLineLazy fallback full parse ✅
- 字段顺序固化（注释）→ Task 1 LazyEntry 注释 ✅
- 阈值 64KB → Task 1 LAZY_ENTRY_THRESHOLD ✅

**Placeholder scan:** Task 3 Step 5/7 的 footer 部分依赖"项目是否有 footer 单元测试 harness"——若无可改为抽 `computeFooterUsage` 纯函数测试（已在 Step 7 落实该抽象）。其余步骤均含真实代码。

**Type consistency:** `LazyEntry`、`peekEntryFields`、`readRawLine`、`materialize`、`computeFooterUsage`、`sumEntriesUsage` 名称在跨 task 引用处一致；`cumulativeUsage: Usage` 在 CompactionEntry / appendCompaction / footer 一致。
