# 模块 C：Compaction 修复实现计划

> **目标**: 合并上游 Compaction 相关的 5 项修复
> **涉及文件**: 3 个
> **无前置依赖**

---

## 文件变动

| 文件 | 操作 | 项 |
|------|------|-----|
| `packages/agent/src/harness/compaction/compaction.ts` | 修改 | C1(tokensAfter), C2(空守卫), C4(retained-token), C5(budget) |
| `packages/coding-agent/src/core/compaction/` | 修改 | C2(空守卫), C3(overflow重试) |
| `packages/coding-agent/src/core/agent-session.ts` | 修改 | C3(assistantIsFromBeforeCompaction 守卫) |

---

## Task 1: C1 — post-compaction token 估算 (0.79.8)

- [ ] **Step 1: 对比上游 CompactionResult 类型**

```bash
diff <(grep -n -A 15 'interface CompactionResult\|export.*CompactionResult\|tokensBefore\|tokensAfter' /data/mine/pi/packages/agent/src/harness/compaction/compaction.ts) \
     <(grep -n -A 15 'interface CompactionResult\|export.*CompactionResult\|tokensBefore\|tokensAfter' /data/mine/earendil-works-pi/packages/agent/src/harness/compaction/compaction.ts)
```

- [ ] **Step 2: 添加 tokensAfter 字段并填充**

在 compaction.ts 中：
1. `CompactionResult` 接口新增 `tokensAfter?: number`
2. `generateSummary` 返回时计算并填充

- [ ] **Step 3: 验证编译**

- [ ] **Step 4: CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.79.8,Compaction,post-compaction token"
```

---

## Task 2: C2 + C3 — 拒绝空 session + overflow 重试 (0.79.8)

> subagent 已确认本地有等价实现，逐项对比确认。

- [ ] **Step 1: 确认 C2 — `messagesToSummarize.length > 0` 守卫**

```bash
grep -n -B 3 -A 5 'messagesToSummarize.length\|No prior history' /data/mine/pi/packages/agent/src/harness/compaction/compaction.ts
```

- [ ] **Step 2: 确认 C3 — `assistantIsFromBeforeCompaction` 守卫**

```bash
grep -n -B 3 -A 5 'assistantIsFromBeforeCompaction' /data/mine/pi/packages/coding-agent/src/core/agent-session.ts
```

- [ ] **Step 3: CSV 标记**

```bash
python3 /tmp/mark-csv.py \
  "0.79.8,Compaction,compaction 拒绝" \
  "0.79.8,Compaction,overflow auto-compaction"
```

---

## Task 3: C4 — retained-token 计入自定义消息 (0.80.4)

- [ ] **Step 1: 对比上游 `tokensBefore` 计算**

```bash
diff <(grep -n -B 5 -A 20 'tokensBefore' /data/mine/pi/packages/agent/src/harness/compaction/compaction.ts) \
     <(grep -n -B 5 -A 20 'tokensBefore' /data/mine/earendil-works-pi/packages/agent/src/harness/compaction/compaction.ts)
```

- [ ] **Step 2: 移植差异**

- [ ] **Step 3: CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.80.4,Compaction,compaction retained-token"
```

---

## Task 4: C5 — post-compaction output budget 忽略陈旧 usage (0.80.6)

- [ ] **Step 1: 对比上游 budget 计算**

```bash
diff <(grep -n -B 3 -A 10 'budget\|output.*token' /data/mine/pi/packages/agent/src/harness/compaction/compaction.ts) \
     <(grep -n -B 3 -A 10 'budget\|output.*token' /data/mine/earendil-works-pi/packages/agent/src/harness/compaction/compaction.ts)
```

- [ ] **Step 2: 移植 + CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.80.6,Compaction,post-compaction output-token"
```

---

## Task 5: 验证与提交

- [ ] **编译 + 测试**

```bash
cd /data/mine/pi && npx tsgo --noEmit 2>&1 | grep error | grep -v test | head -5
npx vitest run --dir packages/agent/test compaction 2>&1 | tail -10
npx vitest run --dir packages/coding-agent/test compaction 2>&1 | tail -10
```

- [ ] **Commit**

```bash
git add packages/agent/src/harness/compaction/ packages/coding-agent/src/core/compaction/ packages/coding-agent/src/core/agent-session.ts
git commit -m "fix(compaction): 合并上游 Compaction 修复 (post-compaction token/budget/overflow)"
```
