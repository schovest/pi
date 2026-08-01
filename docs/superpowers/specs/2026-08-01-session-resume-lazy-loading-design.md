# Session Resume 懒加载设计（v2 修正版）

> **v2 修正（2026-08-01）**：首版假设「buildSessionContext 不碰 compaction 前 lazy 占位」**经实测证伪**——`buildSessionContext` 的 settings 循环遍历整个 leaf→root path 访问 `entry.message.role`，LazyEntry 无 `.message` 会 `TypeError`。本版改为「边界感知 lazy + 全访问点 guard」。

## 概述

解决 resume 超大 session（含大量历史 toolResult）时加载阶段卡死。resume 时对 **compaction 边界之前**的巨型 message 条目只 peek 元数据、不做 `JSON.parse`，需要时按磁盘偏移按需解析（materialize）；对所有解引用 `.message` 的访问点加 guard，使 lazy 占位不致崩溃。不改 JSONL 格式，保留 revert 跨 compaction 能力。

## 背景与根因（数据支撑，不变）

| 文件 | 总大小 | subagent 消息 | 主链 message |
| --- | --- | --- | --- |
| 2026-07-07 (platform) | 199.5 MB | 1%（1.5 MB） | 99%（196.6 MB） |
| 2026-07-25 (pi) | 111.0 MB | 2%（1.8 MB） | 97%（107.3 MB） |

体积集中在主链极少数巨型 toolResult：111MB 文件 Top 3（61.4+25.6+18.5MB）占 98%、全在 compaction 前；199.5MB 文件 Top 5 占 99.5%、无 compaction。来源：`todo`(61-71MB)、`ctx_read`(54MB)、`read`(18-30MB)、`bash`(16MB)。

**根因**：`loadEntriesFromFile` 逐行 `JSON.parse`（单条 70MB 极慢 + GC），其中 compaction 前巨型历史条目已被 compaction summary 逻辑替代却仍全量解析。subagent 消息（1-2%）无关。

## 方案决策（不变）

- **S1 平台级 toolResult 硬截断**：否决（内容不能丢失；源头控制由各插件自行实现）。
- **M2 懒加载**：选定（不改格式、保留 revert）。代价是复杂度。
- ~~M1 物理重写 compaction~~：丢 revert 跨 compaction，不选。

## 关键代码事实（lazy 方案必须处理）

grep 全仓 `.message` 解引用，以下点会对 lazy 占位（无 `.message`）崩溃，**必须 guard**：

| 位置 | 代码 | 触发 |
| --- | --- | --- |
| `buildSessionContext` settings 循环 (445-454) | `entry.type === "message" && entry.message.role === "assistant"` | 每次 buildSessionContext（resume 启动、渲染） |
| `buildSessionContext` appendMessage (462) | `entry.type === "message"` → `messages.push(entry.message)` | compaction 后 emit / 无 compaction emit |
| `_persist` (1003) | hasAssistant `.some(e.message.role)` | resume 后首次 append |
| `createBranchedSession` (1639) | hasAssistant | fork/export |
| `footer.ts:210` | `entry.message.role` / `entry.message.usage` | 每次渲染（热路径） |
| `usage-totals.ts:43-48` | `entry.message.role` / `usage` | 成本统计 |
| `cache-stats.ts:120` | `.message` 解引用 | 缓存统计 |

**关键**：compaction **不重写 parentId 链**，故 `buildSessionContext` 的 leaf→root path 包含 compaction 前所有祖先条目——即使最终只 emit compaction 后条目，settings 循环也会遍历到 compaction 前条目并访问其 `.message.role`。

## 详细设计

### 边界感知 lazy（数据流）

```
loadEntriesFromFile（改造，两阶段）
  第一阶段：流式读，每行记录 byte offset
    ├─ 小行（≤64KB）→ 立即 full parse 进 fileEntries
    ├─ 大行（>64KB）→ 暂存为 PendingEntry {id,parentId,type,timestamp,offset,length}，不全量 parse
    └─ compaction 行 → full parse（小，记录其 offset）
  第二阶段：确定 lastCompactionOffset（最后一个 compaction entry 的行 offset，无则 Infinity）
    ├─ PendingEntry.offset < lastCompactionOffset → 转 LazyEntry（compaction 前，保留 lazy）
    └─ PendingEntry.offset >= lastCompactionOffset → readRawLine + full parse（活跃大行）
       （无 compaction 时所有 PendingEntry 都 full parse → 行为与现状完全一致，零回归）
```

**为什么两阶段**：JSONL append-only，compaction entry 在被压缩消息之后写入；流式读到 compaction 行时才知边界，但前面的大行可能已读——故先暂存 pending，读完全部后据 compaction offset 决策。

### LazyEntry 占位结构（不变）

```typescript
interface LazyEntry {
 type: "message";
 id: string;
 parentId: string | null;
 timestamp: string;
 readonly __lazy: true;
 offset: number;
 length: number;
}
```

`materialize(id)`：seek 到 offset、读 length、`JSON.parse` 单行，替换 byId/fileEntries 中的占位。

### 访问点 guard（核心修正）

**原则**：guard 不丢数据——只读元数据（type/id/parentId）的点用 optional chaining 安全跳过；需要 role/usage 的点保守处理或 materialize。

| 访问点 | guard 行为 |
| --- | --- |
| `buildSessionContext` settings 循环 (445) | `entry.message?.role === "assistant"`（optional chaining）。LazyEntry 主要是 toolResult（非 assistant），跳过 model 提取安全；assistant 通常 <64KB 不 lazy，故无 assistant LazyEntry 边界。 |
| `buildSessionContext` appendMessage (462) | compaction 后条目经边界感知已 full parse（活跃），理论上无 LazyEntry；仍加 `entry.message != null` 守卫防御。 |
| `_persist` hasAssistant (1003) | LazyEntry role 未知，**保守按可能-assistant=true**（只影响 flush 时机，不丢数据）。或 lazy 时 materialize。 |
| `createBranchedSession` hasAssistant (1639) | 同上（fork/export 重操作，亦可 materialize 全部 lazy）。 |
| `footer.ts:210` | 遇 LazyEntry 跳过逐条 usage（Task 3 用 compaction.cumulativeUsage 替代累计，见下节）。 |
| `usage-totals.ts` | 遇 LazyEntry 跳过（成本统计不含 compaction 前细节，可接受）。 |
| `cache-stats.ts` | 遇 LazyEntry 跳过。 |
| `getBranch`/`getEntry`/`getTree` | 返回 lazy 占位；调用方读 `.message` 前 materialize（revert/详情等）。 |

### footer 累计 usage（方案 B：compaction 携带 cumulativeUsage，不变）

`footer.ts` 遍历 `getEntries()` 累加 usage 是唯一热路径。处理：

1. `CompactionEntry` 新增 `cumulativeUsage?: Usage`；`appendCompaction` 内部算 `sumEntriesUsage(this.fileEntries)` 写入。
2. footer：以最后一个带 `cumulativeUsage` 的 compaction 作基线，累加其后条目；跳过 compaction 前 lazy 占位。
3. 抽出可测纯函数 `computeFooterUsage(entries)`。

结果：footer 累计准确 + 不触碰 lazy + 无额外解析。

### `_rewriteFile` / `forkFrom` lazy 原样写回（不变）

LazyEntry 不能 `JSON.stringify`（丢 message）。`_rewriteFile` 与 `forkFrom` 从源文件 offset 读 raw line 原样写回 + 更新占位 offset（rewrite 时）；append-only 下已有 offset 不变。

### 关键约束

1. **peek 稳健性**：regex 提取 `type/id/parentId` 依赖其在序列化时位于 `message` 之前（当前满足）。取不到 → fallback full parse（零丢失）。
2. **无 compaction 零回归**：无 compaction 时所有大行 full parse，行为与现状一致（M2 对无 compaction 大文件本就无效）。
3. **阈值**：`LAZY_ENTRY_THRESHOLD = 64KB`。

## 适用边界（不变）

| 文件类型 | M2 效果 |
| --- | --- |
| 有 compaction（如 111MB） | ✅ 跳过 compaction 前 107MB parse |
| 无 compaction 历史大文件（如 199.5MB） | ❌ 全主链活跃，全量 parse（与现状一致） |

## 测试策略（修正）

- **单元**：fixture **必须含 compaction** 才触发 lazy（无 compaction 大行应 full parse）：
  - 边界：compaction 前大行 lazy / compaction 后大行 full parse / 无 compaction 大行 full parse
  - guard 不崩：buildSessionContext / footer / _persist 遇 lazy 占位不 TypeError（回归）
  - materialize 内容完整
  - footer cumulativeUsage 累计正确
  - _rewriteFile/forkFrom lazy 内容原样保留
- **回归**：现有 session-manager/compaction 全过（小文件零 lazy）。
- **端到端**：真实 111MB 文件 resume 耗时对比；revert 到 compaction 前仍能 materialize。

## 非目标

- 不实现平台级 toolResult 硬截断（S1 否决）。
- 不改 JSONL 格式、不物理清理 compaction 前条目。
- 不解决无 compaction 历史大文件 resume 慢。

## 涉及文件（修正）

| 改动 | 文件 | 内容 |
| --- | --- | --- |
| 边界感知 lazy 读取 | `core/session-manager.ts` | `loadEntriesFromFile` 两阶段 peek+lazy；`LazyEntry`、`LAZY_ENTRY_THRESHOLD`、`peekEntryFields`、`readRawLine`、`materialize` |
| **buildSessionContext guard** | `core/session-manager.ts` | settings 循环 + appendMessage optional chaining / null 守卫 |
| **_persist / createBranchedSession guard** | `core/session-manager.ts` | hasAssistant 遇 lazy 保守 true 或 materialize |
| compaction cumulativeUsage | `core/session-manager.ts` | `CompactionEntry.cumulativeUsage` + `appendCompaction` 计算 + `sumEntriesUsage` |
| **footer guard + computeFooterUsage** | `modes/interactive/components/footer.ts` | 用 cumulativeUsage 基线，跳过 lazy |
| **usage-totals / cache-stats guard** | `core/usage-totals.ts`、`core/cache-stats.ts` | 遇 lazy 跳过 |
| _rewriteFile / forkFrom | `core/session-manager.ts` | lazy raw 原样写回 + offset 更新 |
