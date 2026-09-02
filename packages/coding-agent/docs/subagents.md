# Subagents

> **内置 subagent 工具已移除**（破坏性变更）。本页说明迁移路径与旧会话兼容行为。

## 已移除的内容

- `subagent` 内置工具与 `/subagents`、`/running-subagents` 命令
- SDK API：`session.runSubagents()`、`session.listSubagents()`、`AgentSessionConfig.enableSubagents`
- 会话写入侧的 `subagent_run` 条目（子 agent 运行记录不再进入会话树）
- 自定义定义目录 `~/.pi/agent/subagents/`、`.pi/subagents/` 的内置发现逻辑

## 替代方案

### 方案一：进程隔离扩展示例（随仓库分发）

`examples/extensions/subagent/` 提供进程隔离版 subagent 扩展：每个子任务在独立 `pi` 子进程中运行（`--mode json` 事件流），支持单任务/并行/链式模式、流式渲染与用量统计。

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts
```

详见 `examples/extensions/subagent/README.md`。

### 方案二：生态扩展

社区包 [pi-subagents](https://github.com/nicobailon/pi-subagents)（`pi install npm:pi-subagents`）提供功能更完整的实现：前台/后台运行、steer、会话 fork 继承、workflow 编排、FleetView 等。

## 旧会话兼容

- 旧会话文件中的 `subagent_run` 条目仍可被安全读取：它们不会成为会话 leaf，`pi --resume` 行为不受影响
- 旧记录无 UI 查看入口；执行分支压缩（compaction）时，孤立的 `subagent_run` 子树会随孤儿清理一并移除

## 与 Primary Agent 的关系

`plan` primary agent 的 `excludedTools: ["bash", "subagent"]` 仍保留 `subagent` 排除项：当安装了提供 `subagent` 工具的扩展时，规划 agent 依然不会获得该工具。参见 [Primary Agents](primary-agents.md)。

## 相关文档

- [Extensions](extensions.md) - 编写扩展注册自定义工具
- [Primary Agents](primary-agents.md) - 主 agent 角色切换
