# Session Resume 懒加载设计

## 概述

解决 resume 超大 session（含大量历史 toolResult）时加载阶段卡死的问题。核心思路：resume 时对 **compaction 边界之前**的巨型 message 条目只 peek 元数据、不做 `JSON.parse`，需要时（revert、详情查看等）再按磁盘偏移按需解析（materialize）。

不改 JSONL 文件格式，保留 revert 跨 compaction 能力，兼容现有文件。

## 背景与根因（数据支撑）

对实际 session 文件的测量：

| 文件 | 总大小 | subagent 消息占比 | 主链 message 占比 |
| --- | --- | --- | --- |
| 2026-07-07 (platform) | 199.5 MB | 1.5 MB（1%） | 196.6 MB（99%） |
| 2026-07-25 (pi) | 111.0 MB | 1.8 MB（2%） | 107.3 MB（97%） |

体积集中在主链极少数巨型 toolResult：

- 111 MB 文件：Top 3 巨型 message（61.4 + 25.6 + 18.5 MB）占 98%，全部在 compaction 之前；compaction 后仅 0.3 MB。
- 199.5 MB 文件：Top 5 巨型 message（71.8 + 53.9 + 30.4 + 23.2 + 16.5 MB）占 99.5%，无 compaction。

巨型 toolResult 的来源（按异常程度）：`todo`（61-71 MB，最反常）、`ctx_read`（54 MB）、`read`（18-30 MB）、`bash`（16 MB）。

**根因**：resume 时 `loadEntriesFromFile` 对整个文件逐行 `JSON.parse`（单条 70 MB 的 JSON 极慢 + 触发 GC），其中 compaction 之前的巨型历史条目**逻辑上已被 compaction summary 替代**（`buildSessionContext` 不再使用它们），却每次 resume 都被全量解析。

**关键事实**：subagent 消息只占 1-2%，与本问题无关。

## 方案决策

### 机制层：M2 懒加载（本次实现）

在三个候选中选定 M2：

- ~~M1 物理重写 compaction~~：根治但丢失 revert 跨 compaction 能力。
- **M2 懒加载（不改格式）**：✅ 选定。保留 revert 能力、兼容现有文件。代价是实现复杂度、旧文件磁盘体积不变。
- ~~M3 只做源头 + 手动 vacuum~~：治标不治本。

### 源头层：S1 不实现

~~S1 平台级 toolResult 输出大小强制限制~~：**明确否决**。理由：硬截断会丢失工具结果内容，用户要求"宁可多花上下文也不丢失内容"。源头控制大小由各插件/工具层面自行实现（截断时保留完整内容到可检索位置）。此决策已记入项目约定。

## 详细设计

### 数据流（resume 时）

```
loadEntriesFromFile（改造）
  │ 流式读 JSONL，对每行记录 byte offset + length
  ├─ peek 顶层字段（regex: type / id / parentId）
  ├─ 小行（≤ 阈值，默认 64KB）→ 正常 JSON.parse 进 fileEntries
  ├─ 大行（> 阈值）→ 存 LazyEntry 占位（不解析 message 内容）
  └─ 全部读完后确定 compaction 边界（firstKeptEntryId 集合）
     注：JSONL append-only，compaction entry 在被压缩消息之后写入，
     边界判定须在全部 peek 完成后进行

_buildIndex
  └─ lazy 占位也进 byId（带 __lazy 标记），leaf 计算正常
     （compaction 前大条目本就不参与 leaf，现有 type 判断已处理）

渲染路径（已验证不受影响）
  renderInitialMessages / rebuildChatFromMessages → buildSessionContext
  → 只返回 leaf→root 上 compaction 之后的条目 + compaction summary
  → 不访问 compaction 前 lazy 占位的 .message → 不触发 materialize
```

### LazyEntry 占位结构

```typescript
// compaction 前、体积超阈值的 message 条目的内存表示
interface LazyEntry {
 type: "message";
 id: string;
 parentId: string | null;
 timestamp: string;
 __lazy: true;
 offset: number;   // 在 sessionFile 中的字节偏移
 length: number;   // 该行字节长度
}
```

- `byId.get(id)` 返回 LazyEntry；访问其 `.message` 前必须先 `materialize(id)`。
- `materialize(id)`：seek 到 offset、读 length 字节、`JSON.parse` 单行，用完整 `SessionMessageEntry` 替换 byId 与 fileEntries 中的 lazy 占位。

### materialize 触发点（逐一审查）

| 操作 | 是否触发 materialize | 说明 |
| --- | --- | --- |
| `buildSessionContext` | ❌ 不触发 | 走 leaf→root，遇 compaction 用 summary，不访问 compaction 前条目的 message |
| `_buildIndex` | ❌ | 只用 type / id / parentId |
| `renderInitialMessages` 中数 compaction 数量 | ❌ | 只读 `.type` |
| `handleCompactCommand` 数 message 数量 | ❌ | 只读 `.type` |
| `pruneOrphanedEntries` 判断 | ❌ | 只读 type / parentId；末尾 `_rewriteFile()` 另处理 |
| `getBranch` / `getEntry` / `getTree` | ⚠️ 调用方 | 返回 lazy 占位；调用方读 `.message` 时才 materialize |
| **`_rewriteFile`** | ✅ 触发 | lazy 占位不能 `JSON.stringify`；从 offset+length 读 raw line 原样写回 |
| `createBranchedSession` / export-html | ✅ | 重操作，materialize 全部 lazy（频率低，可接受） |
| **`footer` 累计 usage** | ✅ 见下节 | 唯一热路径，单独用方案 B 处理 |

### footer 累计 usage（方案 B：compaction 携带累计 usage）

`footer.ts` 现遍历 `getEntries()` 累加每个 message 的 usage。lazy 占位无 `.message`，会触碰该热路径。处理方式：

1. compaction 触发时，把"截至 compaction 的累计 usage"（input/output/cacheRead/cacheWrite/cost）写入 `CompactionEntry`，新增字段 `cumulativeUsage?: Usage`。
2. `footer.ts` 遍历 entries 时：遇到 `compaction` entry 用其 `cumulativeUsage` 一次性计入 compaction 前累计，跳过 compaction 前的 lazy 占位（不读 `.message.usage`）。
3. compaction 之后的 message 条目正常累加。

结果：footer 累计 token 准确 + 不触碰 lazy 占位 + 无额外解析开销。

### `_rewriteFile` 与 lazy 占位的交互

- append-only 追加不改变已有条目 offset，lazy 占位的 offset 在 append 后仍有效。
- `_rewriteFile`（被 `pruneOrphanedEntries` / `createBranchedSession` / migrate 调用）会重写整个文件，使所有旧 offset 失效。**选定方案**：rewrite 时对 lazy 占位从 offset+length 读 raw line **原样写回**（保留内容、零丢失），并在写回过程中记录新 offset 更新占位。不采用「rewrite 时 materialize 全部 lazy」——那会让 prune/branch 等操作退化为全量解析，违背 M2 初衷。

### 关键约束

1. **peek 稳健性**：regex 提取依赖 `type` / `id` / `parentId` 在序列化时位于 `message` 对象之前。当前 `SessionMessageEntry`（含 subagent 子树的 message）构造顺序满足此约束（已验证）。**regex 取不到 → fallback full parse**（保守，绝不丢数据）。需固化该字段顺序（代码注释 + 测试防回归）。
2. **offset 有效性**：见上节 `_rewriteFile` 交互。
3. **阈值**：默认 64KB。普通 KB 级 message 正常 parse；几十 MB 的巨型 toolResult 走 lazy。可通过配置调整。

## 适用边界（已确认接受）

| 文件类型 | M2 效果 |
| --- | --- |
| **有 compaction**（如 111 MB 文件，compaction 前 107 MB） | ✅ 显著——resume 跳过 107 MB 的 parse |
| **无 compaction 的历史大文件**（如 199.5 MB 文件） | ❌ 几乎无效——全主链都是活跃上下文，`buildSessionContext` 迟早全部 materialize |

原因：无 compaction 文件的上下文本身就有 200 MB，不是"resume 慢"而是"上下文爆炸"。M2 不改格式，帮不了此类文件。S1 不做后，这类历史文件的缓解靠各插件自行控制输出大小，或用户手动触发 compaction（之后 M2 生效）。

## 测试策略

- **单元（session-manager）**：构造含巨型 compaction 前条目的 fixture，验证：
  - resume 不 parse compaction 前大条目（用 spy/计数器断言 `JSON.parse` 调用次数）
  - byId 结构正确（lazy 占位带元数据 + offset）
  - `materialize(id)` 后内容与原始完整条目逐字节一致
  - footer 累计 usage 从 compaction entry 的 `cumulativeUsage` 正确累加
  - `_rewriteFile` 后 lazy 内容原样保留、offset 更新正确
- **回归**：现有 `session-manager` 测试全过（小文件无 lazy，行为不变）。
- **端到端**：真实 111 MB 文件 resume，对比优化前后耗时；验证 revert 到 compaction 前的节点仍能 materialize 出完整内容并正常渲染。

## 非目标

- 不实现平台级 toolResult 输出大小限制（S1，已否决）。
- 不改 JSONL 文件格式、不物理清理 compaction 前条目。
- 不解决无 compaction 历史大文件的 resume 慢（其上下文本身过大）。

## 涉及文件

| 改动 | 文件 | 内容 |
| --- | --- | --- |
| 懒加载读取 | `packages/coding-agent/src/core/session-manager.ts` | `loadEntriesFromFile` 改造为 peek + lazy；新增 `LazyEntry` 类型、`materialize(id)` 方法 |
| 索引 | 同上 | `_buildIndex` 处理 lazy 占位 |
| 重写 | 同上 | `_rewriteFile` lazy 占位 raw 原样写回 + offset 更新 |
| compaction 累计 usage | `packages/coding-agent/src/core/session-manager.ts`（`appendCompaction` / `CompactionEntry`）+ compaction 触发处 | 新增 `cumulativeUsage` 字段，compaction 时写入截至当前的累计 usage |
| footer | `packages/coding-agent/src/modes/interactive/components/footer.ts` | 遇 compaction 用 `cumulativeUsage`，跳过 compaction 前 lazy 占位 |
| 字段顺序固化 | `packages/coding-agent/src/core/session-manager.ts` | 注释固化 `type/id/parentId` 先于 `message`；regex fallback full parse |
