# 全局 AI 与正式实验运行

更新：2026-10-02。本文是 [实验产品设计](../产品功能文档/实验代码管理详细产品设计.md) 的 E0/E1 接入记录。[Paseo 进度同步](../开发记录/实验工作区进度同步-2026-10-02.md) 描述接入前的检查点。

## 当前行为

在任意页面打开全局 AI，选择或继续绑定代码目录的会话，描述实验目标。AI 可以读取、修改代码，并通过正式运行工具启动实验。每次运行有独立 ID，同时出现在聊天关联实验、实验 Runs 和后台实验任务中。

聊天内可以查看日志与结果、跳转到对应 Run、单独停止实验。AI 可以查询实际日志、退出码、产物与 `metrics.json`，读取其他文本结果并解释。关闭 AI 面板、切换页面/会话/项目或 AI 本轮回复结束不会停止实验。输入框中止键结束当前 AI 轮次；正式实验需单独停止。

长实验不自动开启下一轮付费模型请求。完成状态和结果文件会更新，用户可继续要求原会话分析；本轮仍在执行时，AI 可以等待并查询结果。本轮未加入云端执行、环境自动安装、GPU 排队或独立源码副本。

## 技术链路

```text
全局 AI / 按项目与会话管理的 AgentRuntime
  -> Rust 会话 / Codex app-server
  -> item/tool/call 宿主请求
  -> Rust 实验管理器（与实验页按钮共用）
  -> 独立 Codex 连接 / command/exec / 工作区沙箱
  -> 无界面 Scientify 执行入口 / 实验进程树
  -> 记录、原始日志和结果文件
  -> 工具结果返回 Codex；原生事件唤醒前端列表与日志
```

使用打包的 Codex 0.158.0，未修改上游源码。动态工具是实验性接口，执行连接启用 `experimentalApi: true`。新代码线程在 `thread/start` 注册工具，`thread/resume` 由 Codex 从历史元数据恢复工具。模型配置仍只在 AI 侧栏管理；正式运行连接不调用模型，也不携带供应商密钥。

工具由 Rust 后台处理，不经过前端审批响应通道，不依赖聊天面板挂载。查询期间释放会话锁，其他任务与中止仍可操作。响应前再次检查线程和轮次，避免将旧请求答复到新任务。

| 工具 | 行为 |
| --- | --- |
| `scientify_start_run` | 使用名称、程序、参数数组和相对目录启动正式 Run，立即返回 ID；重复投递同一调用不再次启动 |
| `scientify_list_runs` | 查看绑定代码工作区的运行及已保存配置，不导入其他会话的聊天记录 |
| `scientify_run_status` | 返回状态、退出码、日志末尾、结果列表和可读的 metrics.json；单次最多等待 5 秒 |
| `scientify_read_result` | 读取指定 Run 的 UTF-8 产物；拒绝穿越、链接和内部控制文件；大文本明确标记截断 |
| `scientify_stop_run` | 请求停止指定 Run，再查状态确认；不影响聊天或其他 Run |

Run 来源保存 `conversationId`、`threadId`、`turnId`、`callId`、规范化 `workspaceRoot`。模型不能提交项目 ID、任意根目录或权限模式。读取结果重新核查项目与目录绑定，工作区变化后需新建会话。相同调用标识但不同配置会被拒绝。

## 统一执行权限

AI 轮次和手动/AI 正式运行共用 [execution.rs](../../src-tauri/src/agent/execution.rs) 的 workspace-write 策略，默认网络关闭。正式实验可写代码工作区和本次 artifacts，不自动获得当前用户的无限制写入权限。

正常 AI 命令保留内联审批。正式运行工具不提权；联网安装依赖可走正常 AI 命令审批，之后正式运行仍使用默认权限。实验页按钮不再重复显示“当前用户权限”的确认框。未保存文件仍先确认保存，保存失败不执行；代码会话发送任务前同样检查项目编辑草稿。

Windows 在 AI 和正式运行引擎启动时统一传入 `windows.sandbox="unelevated"`，随后检查 readiness；需要初始化时自动处理，不主动打开管理员终端或 UAC。不能只在启动后调用 setupStart：Codex 的 `command/exec` 缓存启动配置，即使收到 setupCompleted 也可能仍采用旧权限。当前首次运行已用真实沙箱验证，初始化失败会明确失败，不降级为无限制执行。同目录会话仍共享代码和运行记录，聊天历史不自动合并；这不是独立源码副本。workspace-write 也不是只能读取工作区的操作系统隔离容器，解释器和系统依赖仍可读取，临时目录遵循 Codex 的平台策略。

### Windows 兼容

Codex 0.158 的 Windows 沙箱命令不支持流式 `command/exec` 和 terminate，已用真实引擎及版本固定源码核实。Windows 因此使用缓冲命令启动同一个 Scientify 可执行文件的 `--scientify-runner` 入口，该入口先于 Tauri 初始化执行，不创建应用窗口。

运行器仍在 Codex 沙箱内，直接传递参数数组，把原始 stdout/stderr 保存到文件；不拼接 shell 命令或改用无限制执行。宿主约每 100 ms 观察输出，通过原生事件更新界面；列表和日志轮询作为恢复机制。

实验进程先挂起、加入独立 Windows Job Object、再恢复执行，避免子进程逃出任务管理。停止标记终止 Job 内的进程树，Job 关闭也会清理；宿主心跳超过 10 秒未更新时自动清理。首次引擎与操作系统加载可能增加启动等待。

非提权沙箱中的 Windows PowerShell 可能启用 ConstrainedLanguage；依赖任意 .NET 方法的命令应改用标准 cmdlet 或项目的 Python/Node 程序。本轮测试使用标准文件写入命令验证权限，另用发布版 Node 实验验证原生文件写入，并未通过解除语言限制来绕过沙箱。

运行器自身的启动错误同样写入日志，避免 Windows 无界面程序仅返回退出码而丢失诊断信息。

参考：[官方 app-server 接口](https://developers.openai.com/codex/app-server)、[Codex 0.158 Windows 命令实现](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/app-server/src/command_exec.rs)、[命令执行的配置加载](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/app-server/src/request_processors/command_exec_processor.rs)。

## 存储与恢复

| 数据 | 位置 |
| --- | --- |
| 配置 | 工作区项目 `runConfigurations` |
| 来源、状态、执行快照 | `<data>/experiments/<runId>/record.json` |
| Windows 日志与内部控制文件 | `<data>/experiments/<runId>/artifacts/.scientify/`，结果列表不展示该保留目录 |
| 结果 | `<data>/experiments/<runId>/artifacts/`，脚本通过 SCIENTIFY_RUN_DIR 写入 |
| 旧版日志 | 仍可读取原有 output.log |
| 注释与导入指标 | 工作区 runs |

最多同时运行 8 个实验，超出直接拒绝。日志界面最多读取末尾 256 KiB，日志超过 64 MiB 触发停止，观察间隔内可能少量超出。应用重启将未完成记录标为中断，不自动重放。仅导出工作区 JSON 不包含实验目录。

旧代码会话首次接入工具时换用新引擎线程，可见聊天历史保留；按现有迁移逻辑带入最近 24 条消息、最多约 24 KiB 的历史文本，不宣称完整迁移工具历史。原生旧线程文件保留，新线程之后可以恢复工具和引擎历史。

## 手动验收

使用可删除的测试项目、真实代码目录、已配置的 Responses 兼容模型，不使用重要研究数据。

1. 从全局 AI 的代码会话发送：“创建最小测试实验，每秒输出一行，运行 5 秒，在 SCIENTIFY_RUN_DIR 保存 metrics.json，accuracy 为 0.9；通过正式实验运行并读取结果。”检查实际代码、关联实验、唯一 ID、逐步追加的日志、结果文件及 AI 基于真实指标的解释。
2. 从聊天打开运行图标进入 Runs。两处 ID、状态应相同，来源显示 AI 实验，运行信息包含来源会话、任务和执行权限。
3. 启动 30 秒实验，再切换另一会话或项目启动第二个。导航和编辑器应可用，各次运行的日志独立。
4. 在输入框中止 AI 轮次，正式实验继续；单独停止其中一个实验，它应变为已取消，另一实验继续。
5. 检查成功与失败的退出码、日志和结果。要求 AI 查询旧 Run；读取其他项目 Run 或 ../record.json 应被拒绝。
6. 手动运行相同配置，权限同为工作区沙箱。测试脚本写项目外的临时文件应失败且不改变文件；写代码目录和 SCIENTIFY_RUN_DIR 应成功。
7. 制造未保存改动或保存冲突，再从 AI 或按钮发起任务。拒绝保存或保存失败应保留输入和草稿，不启动任务。
8. 停止实验并重启，检查记录、日志、结果和原会话；不得自动重跑或弹出独立终端。正常关闭前仍需停止后台任务。

自动验证使用隔离临时目录、真实打包 Codex 和本地确定性 Responses 服务，不使用用户密钥，覆盖工具往返、来源绑定、请求去重、实际日志和指标回传、历史恢复、产物围栏、外部写入拒绝、两个真实运行的独立停止。真实模型的工具选择、冷启动速度和桌面窗口体验仍需人工验收。

Windows Release 构建后可运行 `node scripts/verify-experiment-runner.mjs`，直接通过真实打包 Codex 沙箱验证发布版无界面入口、运行中日志、结果 JSON 和外部文件写入拒绝。此检查不调用模型，不使用用户密钥，测试文件结束后清理。具体执行结果见 [验收记录](Agent-Harness-验收计划.md#2026-10-02全局-ai-与正式实验运行)。

## 实现入口

- [工具桥接](../../src-tauri/src/agent/tools.rs)、[共享权限](../../src-tauri/src/agent/execution.rs)、[引擎管道](../../src-tauri/src/agent/process.rs)。
- [运行管理器](../../src-tauri/src/experiments.rs)、[Windows 运行器](../../src-tauri/src/experiments/runner.rs)、[无界面入口](../../src-tauri/src/main.rs)。
- [聊天关联运行](../../src/features/assistant/AssistantRuns.tsx)、[状态与事件](../../src/workspaces/experiments/runtime.ts)、[日志与结果](../../src/workspaces/experiments/ExecutionPanel.tsx)。
