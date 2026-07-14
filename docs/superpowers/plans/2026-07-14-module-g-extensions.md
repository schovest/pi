# 模块 G：Extension API 增强实现计划

> **目标**: 合并上游扩展 API 相关 11 项增强
> **涉及文件**: 5 个
> **前置依赖**: 模块 A

---

## 文件变动

| 文件 | 操作 | 项 |
|------|------|-----|
| `packages/coding-agent/src/core/extensions/types.ts` | 修改 | G1(compact事件), G4(session_info), G6(agent_settled), G7(headers), G8(Inline), G9(renderers), G10(dynamic) |
| `packages/coding-agent/src/core/extensions/runner.ts` | 修改 | G2(transient UI), G5(tool apply), G6-G10(事件发射) |
| `packages/coding-agent/src/core/extensions/loader.ts` | 修改 | G8(Inline), G10(dynamic tools) |
| `packages/coding-agent/src/core/agent-session.ts` | 修改 | G4-G7(生命周期钩子) |
| `packages/coding-agent/src/main.ts` | 修改 | G3(-ne hint) |

---

## Task 1: G1 + G3 — 低复杂度项

- [ ] **G1 (0.79.10): SessionCompactEvent 加 reason/willRetry**

```bash
# 对比上游 types.ts 新增字段
grep -n -A 10 'SessionCompactEvent' /data/mine/earendil-works-pi/packages/coding-agent/src/core/extensions/types.ts
# 对比上游 emit 位置传递 reason/willRetry
grep -n -B 5 -A 5 'session_compact' /data/mine/earendil-works-pi/packages/coding-agent/src/core/agent-session.ts | head -40
```

- [ ] **G3 (0.80.0): 扩展崩溃提示 pi -ne**

```bash
grep -n 'EXTENSION_LOAD_FAILURE_HINT' /data/mine/earendil-works-pi/packages/coding-agent/src/main.ts
```

在 main.ts 中添加常量并在启动失败时展示。

## Task 2: G2 + G4 + G5 — 中复杂度项

- [ ] **G2 (0.79.10): transient UI 消息 reload 后保持可见**

对比上游 `runner.ts` 中消息可见性管理 → 移植。

- [ ] **G4 (0.80.3): session_info_changed 事件**

对比上游 `setSessionName` → 发送事件 → 移植到本地 agent-session.ts。

- [ ] **G5 (0.80.3): extension tool changes 在下一次 request 前应用**

对比上游 agent-loop 中工具刷新时机 → 移植。

## Task 3: G6-G10 — 高复杂度项（逐项对比移植）

> 这些是上游新增的扩展 API 架构概念，需要完整移植上游实现。

| # | 项 | 上游关键文件 |
|---|-----|-------------|
| G6 | agent_settled 事件 + idle 等待 | `extensions/types.ts` + `agent-session.ts` + `agent-harness.ts` |
| G7 | before_provider_headers 注入 | `extensions/types.ts` + provider 调用链 hook 点 |
| G8 | InlineExtension 类型 | `extensions/types.ts` + `loader.ts` |
| G9 | entry renderers (display-only) | `extensions/types.ts` + `agent-session.ts` + interactive-mode |
| G10 | dynamic tool loading | `extensions/types.ts` + `agent-session.ts` + tool manager |

- [ ] **逐项执行：diff → 移植 → 编译验证 → CSV 标记**

## Task 4: 提交

```bash
git add packages/coding-agent/src/core/extensions/ packages/coding-agent/src/core/agent-session.ts packages/coding-agent/src/main.ts
git commit -m "feat(extensions): 合并上游 Extension API 增强 (agent_settled/before_provider_headers/Inline/dynamic tools)"
```
