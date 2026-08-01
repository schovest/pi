# Session Resume 懒加载设计（v3 修正版）

> **v3 修正（2026-08-01）**：① 去掉 64KB 阈值——lazy 纯粹基于 compaction 边界（compaction 前所有行 lazy，不限大小）；② chatbox 不渲染 `[compaction]` summary 块（LLM 上下文仍保留 summary），compaction 前历史只在 tree 查看（materialize-on-view）。
>
> **v2 修正（2026-08-01）**：首版假设「buildSessionContext 不碰 compaction 前 lazy 占位」经实测证伪——settings 循环遍历 leaf→root path 访问 `entry.message.role`，LazyEntry 无 `.message` 会 `TypeError`。v2 改为「边界感知 lazy + 全访问点 guard」。

## 概述

解决 resume 超大 session（含大量历史 toolResult）时加载阶段卡死。resume 时对 **compaction 边界之前**的所有条目只 peek 元数据、不做 `JSON.parse`（v3 去掉 64KB 大小门槛），需要时按磁盘偏移按需解析（materialize）；chatbox 不渲染 compaction summary 块，compaction 前历史只在 tree 查看。对所有解引用 `.message` 的访问点加 guard，使 lazy 占位不致崩溃。不改 JSONL 格式，保留 revert 跨 compaction 能力。

## 背景与根因（数据支撑，不变）

| 文件 | 总大小 | subagent 消息 | 主链 message |
| --- | --- | --- | --- |
| 2026-07-07 (platform) | 199.5 MB | 1%（1.5 MB） | 99%（196.6 MB） |
| 2026-07-25 (pi) | 111.0 MB | 2%（1.8 MB） | 97%（107.3 MB） |

体积集中在主链极少数巨型 toolResult：111MB 文件 Top 3（61.4+25.6+18.5MB）占 98%、全在 compaction 前；199.5MB 文件 Top 5 占 99.5%、无 compaction。来源：`todo`(61-71MB)、`ctx_read`(54MB)、`read`(18-30MB)、`bash`(16MB)。

**根因**：`loadEntriesFromFile` 逐行 `JSON.parse`，其中 compaction 前历史条目已被 compaction summary 逻辑替代却仍全量解析。subagent 消息（1-2%）无关。

## 方案决策

- **S1 平台级 toolResult 硬截断**：否决（内容不能丢失）。
- **M2 懒加载**：选定（不改格式、保留 revert）。
- ~~M1 物理重写 compaction~~：丢 revert 跨 compaction，不选。
- **v3 补充**：① lazy 判定纯按 compaction 边界（去 64KB——compaction 前小行 parse 是浪费，它们同样不展示）；② chatbox 不渲染 compaction summary 块（UI 简化，compaction 前历史只在 tree 查看时 materialize）。

## 关键代码事实（lazy 方案必须处理，不变）

grep 全仓 `.message` 解引用，以下点会对 lazy 占位崩溃，**必须 guard**：`buildSessionContext` settings 循环(445)/appendMessage(462)、`_persist`(1003)、`createBranchedSession`(1639)、`footer.ts:210`、`usage-totals.ts`、`cache-stats.ts`、`sessionEntryToContextMessages`(368)+compaction.ts、`branch-summarization.ts`、tree-selector、export-html 等（v2/Task 2 已全量覆盖）。

**关键**：compaction **不重写 parentId 链**，`buildSessionContext` 的 leaf→root path 含 compaction 前祖先条目，settings 循环访问其 `.message.role`。

## 详细设计

### 边界感知 lazy（v3：纯 compaction 边界，无 64KB）

```
loadEntriesFromFile（改造，两阶段）
  第一阶段：流式读，每行 peek 元数据(type/id/parentId/timestamp) + 记 byte offset
    ├─ type=session (header) → full parse（小，需完整 header）
    ├─ type=compaction → full parse（小，记 lastCompactionOffset = offset）
    └─ 其他(message/custom/etc) → PendingEntry {id,parentId,type,timestamp,offset,length}，不全量 parse body
  第二阶段：确定 lastCompactionOffset（最后一个 compaction 行 offset，无则 null）
    ├─ PendingEntry.offset < lastCompactionOffset → LazyEntry（compaction 前，全 lazy，不限大小）
    └─ PendingEntry.offset >= lastCompactionOffset → readRawLine + full parse（活跃条目）
       （无 compaction 时 lastCompactionOffset=null → 所有 PendingEntry 都 full parse，零回归）
```

**为什么两阶段**：JSONL append-only，compaction entry 在被压缩消息之后写入；流式读到 compaction 行才知边界，但前面的行已读——故先暂存 pending（不 parse body），读完全部后据 compaction offset 决策。

**v3 vs v2**：v2 只对 >64KB 大行 peek，compaction 前 ≤64KB 小行仍 full parse（浪费——它们不展示）。v3 对所有非 header/compaction 行 peek，compaction 前全部 lazy（含小行），更省 parse + 内存。代价：compaction 后活跃行多一次 readRawLine（行数少，可接受）。

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

### chatbox 渲染 + tree materialize-on-view（v3 新增）

**chatbox**：`renderSessionContext`（interactive-mode.ts:3847）遍历 `sessionContext.messages` 渲染。跳过 compaction summary 消息（`createCompactionSummaryMessage` 产生的）——不渲染 `[compaction]` 块。chatbox 只显示 compaction 之后的实际对话。

**LLM 上下文不变**：`buildSessionContext` 仍返回 summary（LLM 需要知道历史被压缩，否则上下文断裂）。只改 UI 渲染层。

**tree**：tree-selector 显示 lazy 条目时（展开/查看/peek），调用 `sessionManager.materialize(id)` 获取完整内容。当前 tree 对 lazy 是 `[lazy message]` 占位（guard 防崩）；v3 改为 materialize-on-view，让 tree 真正能查看 compaction 前历史。

**用户感知**：compaction 前的历史不污染 chatbox；想回顾时进 tree，展开即 materialize 出完整内容。

### 访问点 guard（v2 已实现 + v3 微调）

optional chaining（`entry.message?.role`）。v3 后 compaction 前 assistant 也可能 lazy（不再有"assistant <64KB 不 lazy"假设）——guard 对所有 lazy（含 assistant）安全跳过；buildSessionContext 提取 model 时遇 lazy assistant 跳过（model 信息可从 model_change entry 或 compaction 后 assistant 获得，可接受）。

### footer 累计 usage（方案 B：compaction 携带 cumulativeUsage，v2 已实现）

`CompactionEntry.cumulativeUsage`；footer `computeFooterUsage` 以最后一个 cumulativeUsage 作基线 + 累加其后，跳过 lazy 占位。

### `_rewriteFile` / `forkFrom` lazy 原样写回（v2 已实现）

LazyEntry 从源文件 offset 读 raw line 原样写回 + 更新 offset。

### 关键约束

1. **peek 稳健性**：regex 提取 `type/id/parentId` 依赖其在序列化时位于 body 之前（当前满足）。取不到 → fallback full parse（零丢失）。
2. **无 compaction 零回归**：无 compaction 时所有行 full parse，行为与现状一致。
3. ~~阈值 `LAZY_ENTRY_THRESHOLD`~~：**v3 移除**（lazy 纯按 compaction 边界）。

## 适用边界（v3 更新）

| 文件类型 | M2 效果 |
| --- | --- |
| 有 compaction（如 111MB） | ✅ 跳过 compaction 前 **所有** 条目 parse（v3 含小行，比 v2 更快更省内存） |
| 无 compaction 历史大文件（如 199.5MB） | ❌ 全主链活跃，全量 parse（与现状一致） |

## 测试策略（v3 更新）

- **去 64KB**：移除 `LAZY_ENTRY_THRESHOLD` 相关测试；新增"compaction 前小行也 lazy"测试。
- **chatbox 不渲染 summary**：`renderSessionContext` 遇 compaction summary 消息不渲染 `[compaction]` 块。
- **tree materialize-on-view**：tree 展开/查看 lazy 条目时 `materialize` 出完整内容。
- 保留 v2 测试：边界决策、guard 不崩、materialize 完整、footer cumulativeUsage、_rewriteFile/forkFrom lazy 保留。
- **回归**：现有 session-manager/compaction/footer/tree-selector 全过。
- **端到端**：真实 111MB 文件 resume 耗时对比（v3 应比 v2 更快）。

## 非目标

- 不实现平台级 toolResult 硬截断（S1 否决）。
- 不改 JSONL 格式、不物理清理 compaction 前条目。
- 不解决无 compaction 历史大文件 resume 慢。
- 不改 LLM 上下文（buildSessionContext 仍含 summary）。

## 涉及文件（v3 更新）

| 改动 | 文件 | 内容 |
| --- | --- | --- |
| **去 64KB，纯 compaction 边界 lazy** | `core/session-manager.ts` | `loadEntriesFromFile` 改为所有行 peek + 边界决策；移除 `LAZY_ENTRY_THRESHOLD` |
| **chatbox 不渲染 summary** | `modes/interactive/interactive-mode.ts` | `renderSessionContext` 跳过 compaction summary 消息 |
| **tree materialize-on-view** | `modes/interactive/components/tree-selector.ts` | lazy 条目展开/查看时调 `sessionManager.materialize(id)` |
| guard / cumulativeUsage / 序列化 | （v2 已实现，保留） | session-manager/footer/usage-totals/cache-stats/compaction/tree-selector/export-html |
