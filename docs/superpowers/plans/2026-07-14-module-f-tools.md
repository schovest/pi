# 模块 F：Tools 修复实现计划

> **目标**: 合并上游内建工具 4 项修复
> **涉及文件**: 5 个
> **无前置依赖**

---

## 文件变动

| 文件 | 操作 | 项 |
|------|------|-----|
| `packages/coding-agent/src/core/tools/edit-diff.ts` | 修改 | F1(fuzzy edit), F4(extra fields) |
| `packages/coding-agent/src/core/tools/edit.ts` | 修改 | F4(schema) |
| `packages/coding-agent/src/core/tools/bash.ts` | 修改 | F2(WSL stdin) |
| `packages/coding-agent/src/core/tools/find.ts` | 修改 | F3(nested git) |
| `packages/coding-agent/src/utils/shell.ts` | 修改 | F2(WSL shell) |

---

## Task 1: F1 — fuzzy edit 保留未触碰行块 (0.79.9)

- [ ] **对比上游 `applyEditsToNormalizedContent` 实现**

```bash
diff <(sed -n '200,300p' /data/mine/pi/packages/coding-agent/src/core/tools/edit-diff.ts) \
     <(sed -n '200,300p' /data/mine/earendil-works-pi/packages/coding-agent/src/core/tools/edit-diff.ts)
```

- [ ] **移植差异 + CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.79.9,Tools,fuzzy edit matches"
```

## Task 2: F2 — bash WSL bash.exe stdin (0.79.9)

- [ ] **对比上游 shell spawn 逻辑**

```bash
diff <(grep -n -B 3 -A 10 'spawn\|stdio.*stdin\|bash.exe\|WSL\|stdin.*pipe' /data/mine/pi/packages/coding-agent/src/core/tools/bash.ts) \
     <(grep -n -B 3 -A 10 'spawn\|stdio.*stdin\|bash.exe\|WSL\|stdin.*pipe' /data/mine/earendil-works-pi/packages/coding-agent/src/core/tools/bash.ts)
```

```bash
diff <(grep -n -B 3 -A 10 'bash.exe\|WSL\|windows\|stdin' /data/mine/pi/packages/coding-agent/src/utils/shell.ts) \
     <(grep -n -B 3 -A 10 'bash.exe\|WSL\|windows\|stdin' /data/mine/earendil-works-pi/packages/coding-agent/src/utils/shell.ts)
```

- [ ] **移植 + CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.79.9,Tools,bash WSL"
```

## Task 3: F3 — find 尊重嵌套 git 边界 (0.79.10)

- [ ] **对比上游 `--no-require-git` 处理**

```bash
diff <(grep -n -B 2 -A 8 'no-require-git\|nested\|gitignore\|ignore.*file' /data/mine/pi/packages/coding-agent/src/core/tools/find.ts) \
     <(grep -n -B 2 -A 8 'no-require-git\|nested\|gitignore\|ignore.*file' /data/mine/earendil-works-pi/packages/coding-agent/src/core/tools/find.ts)
```

- [ ] **移植 + CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.79.10,Tools,find 尊重嵌套"
```

## Task 4: F4 — edit 允许额外字段 (0.80.4)

- [ ] **对比上游 edit 工具 schema**

```bash
diff <(grep -n -B 2 -A 10 'edits\|additionalProperties\|schema' /data/mine/pi/packages/coding-agent/src/core/tools/edit.ts) \
     <(grep -n -B 2 -A 10 'edits\|additionalProperties\|schema' /data/mine/earendil-works-pi/packages/coding-agent/src/core/tools/edit.ts)
```

- [ ] **移植 + CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.80.4,Tools,edit tool schema"
```

## Task 5: 提交

```bash
git add packages/coding-agent/src/core/tools/edit-diff.ts \
        packages/coding-agent/src/core/tools/edit.ts \
        packages/coding-agent/src/core/tools/bash.ts \
        packages/coding-agent/src/core/tools/find.ts \
        packages/coding-agent/src/utils/shell.ts
git commit -m "fix(tools): 合并上游 Tools 修复 (fuzzy edit/WSL bash/find git/edit schema)"
```
