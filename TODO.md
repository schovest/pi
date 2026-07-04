# TODO

## Feature

### 命令后台运行

**目标**：bash 命令超时后不报错，而是自动转为后台运行；新增快捷键管理后台进程；进程结束后自动通知 agent 继续执行。

#### 关键设计决策

| 决策点 | 方案 |
|--------|------|
| 超时阈值 | 新增 `settings.json` 配置项（默认 120s），LLM 工具参数传入的 `timeout` 优先 |
| 完成通知 | 进程结束后注入一条 **user message**（复用 `followUpQueue`），内容含命令、退出码、输出摘要 |
| 并发处理 | 通知**排队不打断**——agent 正在 streaming 时进入 `followUpQueue`；agent 空闲时直接调用 `prompt()` 触发新 turn |
| 管理界面 | ctrl-Down 打开后台进程列表，支持**查看输出 + 手动 Kill** |

#### 实现要点

1. **超时转后台**（`bash.ts` + `createLocalBashOperations`）
   - 超时触发时不再 `killProcessTree`，而是将进程注册到后台进程管理器
   - 工具调用正常返回，返回内容告知 agent："命令已转入后台运行，PID: xxx，结束后会通知"
   - 超时阈值取值优先级：工具参数 `timeout` > settings 全局配置 > 默认 120s

2. **后台进程管理器**（新增模块）
   - 维护运行中后台进程的注册表：`{ id, pid, command, startedAt, status, exitCode, outputBuffer }`
   - 持续捕获 stdout/stderr（复用 `OutputAccumulator`，截断策略与前台一致）
   - 进程退出监听：通过 `child.on('exit')` 回调，收集退出码 + 最终输出，组装通知消息
   - 生命周期绑定：注册到 `trackDetachedChildPid`，确保 pi 退出时一并杀死

3. **完成通知**（`AgentSession` / `Agent`）
   - 进程退出后，组装 user message：`"[后台命令完成] \`make build\` 退出码 0，输出: ...（完整输出: /tmp/pi-bash-xxx）"`
   - 通过 `followUpQueue` 注入，不打断 agent 当前任务

4. **ctrl-Down 管理界面**（TUI）
   - 快捷键注册到 `keybindings.json`（`app.backgroundProcesses` 或类似 action）
   - 界面展示：命令 / PID / 运行时长 / 状态（运行中·已完成）/ 退出码
   - 交互：选中进程 → 查看完整输出 / Kill 运行中进程

#### 约束

- 后台进程必须是 pi agent 的子进程，生命周期与 pi agent 一致（退出时统一清理）
- 后台进程输出截断策略与前台 bash 一致（默认 250 行 / 200KB，超出存临时文件）
