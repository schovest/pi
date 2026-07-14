# 模块 E：Stability 修复实现计划

> **目标**: 合并上游稳定性相关 9 项修复
> **涉及文件**: ~8 个
> **无前置依赖**

---

## 文件变动

| 文件 | 操作 | 项 |
|------|------|-----|
| `packages/agent/src/agent-loop.ts` | 修改 | E2(output length error), E7(truncated tool calls) |
| `packages/ai/src/providers/*.ts` | 已由模块A替换 | E4(gRPC retry), E5(Cloudflare 524) |
| `packages/ai/src/api/openai-completions.ts`(新) | 已由模块A引入 | E6(null content) |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | 修改 | E1(session switch) |
| `packages/coding-agent/src/core/http-dispatcher.ts` | 修改 | E8(Bun socket-drop) |
| `packages/coding-agent/src/core/resource-loader.ts` | 修改 | E9(Windows context) |

---

## Task 1: E1 + E9 — session switch + Windows context

- [ ] **E1 (0.79.9): same-dir session switch 复用扩展模块**

```bash
diff <(grep -n -A 20 'switchSession\|createRuntime\|reuse' /data/mine/pi/packages/coding-agent/src/core/agent-session-runtime.ts) \
     <(grep -n -A 20 'switchSession\|createRuntime\|reuse' /data/mine/earendil-works-pi/packages/coding-agent/src/core/agent-session-runtime.ts)
```

- [ ] **E9 (0.80.4): Windows 项目 context 文件发现**

```bash
diff <(grep -n -B 2 -A 10 'canonicalizePath\|parentDir\|dirname.*parent\|traverse\|discover' /data/mine/pi/packages/coding-agent/src/core/resource-loader.ts) \
     <(grep -n -B 2 -A 10 'canonicalizePath\|parentDir\|dirname.*parent\|traverse\|discover' /data/mine/earendil-works-pi/packages/coding-agent/src/core/resource-loader.ts)
```

## Task 2: E2 + E7 — output length error + truncated tool calls (0.80.3, 0.80.4)

- [ ] **对比上游 agent-loop.ts 差异**

```bash
diff <(grep -n -B 3 -A 10 'stopReason.*length\|output.*truncat\|truncated\|incomplete' /data/mine/pi/packages/agent/src/agent-loop.ts) \
     <(grep -n -B 3 -A 10 'stopReason.*length\|output.*truncat\|truncated\|incomplete' /data/mine/earendil-works-pi/packages/agent/src/agent-loop.ts)
```

## Task 3: E3 + E4 + E5 + E8 — retry 分类修复

> E4、E5 的 retry 模式已在模块 A 的新 api/ 文件中。E3、E8 需对比移植。

- [ ] **E3 (0.80.3): auto-retry stream errors — 忽略匹配模式的错误**

- [ ] **E8 (0.80.4): Bun socket-drop — 添加 `socket connection was closed` 到 retry 模式**

```bash
grep -n 'socket.*connection.*was.*closed\|ecConnectionReset\|EPIPE\|retry.*pattern' /data/mine/earendil-works-pi/packages/ai/src/api/simple-options.ts 2>/dev/null
```

## Task 4: E6 — null message content 标准化 (0.80.4)

- [ ] **确认新 api/openai-responses-shared.ts 已包含 null content 处理（模块 A 已引入）**

## Task 5: 验证与提交

```bash
cd /data/mine/pi && npx tsgo --noEmit 2>&1 | grep error | grep -v test | head -5
# CSV 批量标记
python3 /tmp/mark-csv.py \
  "0.79.9,Stability,same-directory session" \
  "0.80.3,Stability,assistant messages stopped" \
  "0.80.3,Stability,auto-retry provider stream" \
  "0.80.4,Stability,gRPC ResourceExhausted" \
  "0.80.4,Stability,Cloudflare 524" \
  "0.80.4,Stability,null message content" \
  "0.80.4,Stability,长度截断 assistant" \
  "0.80.4,Stability,Bun fetch socket-drop" \
  "0.80.4,Stability,Windows 项目 context"
git commit -m "fix(stability): 合并上游 Stability 修复 (retry/truncated/Windows/null content)"
```
