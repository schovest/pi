# 模块 H：Misc 修复实现计划

> **目标**: 合并上游杂项 3 项修复
> **涉及文件**: 3 个
> **无前置依赖**

---

## 文件变动

| 文件 | 操作 | 项 |
|------|------|-----|
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | 修改 | H1(get_entries/get_tree) |
| `packages/coding-agent/src/core/session/jsonl-storage.ts` | 修改 | H2(JSONL metadata) |
| `packages/coding-agent/package.json` | 修改 | H3(依赖版本) |

---

## Task 1: H1 — RPC get_entries/get_tree (0.80.3)

- [ ] **Step 1: 对比上游 rpc-mode.ts 新增命令**

```bash
diff <(grep -n 'get_entries\|get_tree' /data/mine/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts) \
     <(grep -n 'get_entries\|get_tree' /data/mine/earendil-works-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
```

- [ ] **Step 2: 移植两个新命令实现**

从上游找到 `get_entries` 和 `get_tree` 的 switch case 块 → 复制到本地 rpc-mode.ts

- [ ] **Step 3: 验证编译 + CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.80.3,RPC,get_entries"
```

## Task 2: H2 — JSONL session metadata (0.80.4)

- [ ] **Step 1: 对比上游 jsonl-storage.ts**

```bash
diff <(grep -n 'metadata\|header\|custom' /data/mine/pi/packages/coding-agent/src/core/session/jsonl-storage.ts) \
     <(grep -n 'metadata\|header\|custom' /data/mine/earendil-works-pi/packages/coding-agent/src/core/session/jsonl-storage.ts)
```

- [ ] **Step 2: 添加 metadata 字段序列化/反序列化**

- [ ] **Step 3: CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.80.4,SDK,JSONL session headers"
```

## Task 3: H3 — 安全依赖更新 (0.79.8)

- [ ] **Step 1: 检查当前版本**

```bash
grep '"undici"' /data/mine/pi/packages/coding-agent/package.json
grep '"protobufjs"' /data/mine/pi/packages/coding-agent/package.json 2>/dev/null || echo "not found"
```

- [ ] **Step 2: 如需要更新，对齐上游版本并刷新 lockfile**

```bash
cd /data/mine/pi
npm install --package-lock-only --ignore-scripts
```

- [ ] **Step 3: CSV 标记**

```bash
python3 /tmp/mark-csv.py "0.79.8,Security,更新漏洞依赖"
```

## Task 4: 提交

```bash
git add packages/coding-agent/src/modes/rpc/rpc-mode.ts \
        packages/coding-agent/src/core/session/jsonl-storage.ts \
        packages/coding-agent/package.json
git commit -m "fix(misc): 合并上游 Misc 修复 (RPC get_entries/tree, JSONL metadata, 安全依赖)"
```
