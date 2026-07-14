# 模块 D：Session 修复实现计划

> **目标**: 合并上游 Session 相关 5 项修复
> **涉及文件**: 3 个
> **无前置依赖**

---

## 文件变动

| 文件 | 操作 | 项 |
|------|------|-----|
| `packages/coding-agent/src/core/session-manager.ts` | 修改 | D1(getTree O(n)), D4(invalid reject) |
| `packages/coding-agent/src/modes/interactive/components/session-selector.ts` | 修改 | D2(子树排序) |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | 修改 | D3(resource order), D5(session-id) |

---

## Task 1: D1 — deep branches 二次方→线性 (0.79.9)

- [ ] **对比上游 `getTree()` 实现**

```bash
diff <(grep -n -A 40 'getTree()' /data/mine/pi/packages/coding-agent/src/core/session-manager.ts) \
     <(grep -n -A 40 'getTree()' /data/mine/earendil-works-pi/packages/coding-agent/src/core/session-manager.ts)
```

- [ ] **移植差异 + CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.79.9,Session,deep session branches"
```

## Task 2: D2 — session selector 子树排序 (0.80.0)

- [ ] **对比上游排序逻辑（子树内 max modified）**

```bash
diff <(grep -n -B 5 -A 15 'sort.*modified\|subtree\|latest' /data/mine/pi/packages/coding-agent/src/modes/interactive/components/session-selector.ts) \
     <(grep -n -B 5 -A 15 'sort.*modified\|subtree\|latest' /data/mine/earendil-works-pi/packages/coding-agent/src/modes/interactive/components/session-selector.ts)
```

- [ ] **移植 + CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.80.0,Session,session selector 按子树"
```

## Task 3: D3-D5 — resource 顺序 + session reject + session-id (0.80.3)

- [ ] **逐项对比上游，确认本地已有等价实现或移植差异**

```bash
# D3: resource notifications before messages
grep -rn 'resourceNotification\|before.*message\|resume.*resource' /data/mine/pi/packages/coding-agent/src/core/agent-session-runtime.ts | head -5
# D4: --session reject invalid
grep -rn 'invalid.*session\|reject.*session\|SessionImport' /data/mine/pi/packages/coding-agent/src/core/session-manager.ts | head -5
# D5: --no-session --session-id
grep -rn 'no.sesssion.*session.id\|sessionId.*deterministic\|createBranched' /data/mine/pi/packages/coding-agent/src/core/ | head -5
```

- [ ] **CSV 标记**

```bash
python3 /tmp/mark-csv.py \
  "0.80.3,Session,resume sessions" \
  "0.80.3,Session,--session 和 SessionManager" \
  "0.80.3,Session,--no-session --session-id"
```

## Task 4: 提交

```bash
git add packages/coding-agent/src/core/session-manager.ts \
        packages/coding-agent/src/modes/interactive/components/session-selector.ts \
        packages/coding-agent/src/core/agent-session-runtime.ts
git commit -m "fix(session): 合并上游 Session 修复 (deep branches/子树排序/resource order/session-id)"
```
