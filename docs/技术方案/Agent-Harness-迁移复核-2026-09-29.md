# Scientify 内置 Codex 迁移复核（2026-09-29）

## 结论先行

Scientify 采用 Codex `app-server` 作为内置 harness 的方向是正确的。当前问题不是“不能把 Codex 嵌进 Tauri”，而是此前只完成了 sidecar 的启动和一部分 JSON-RPC 包装，没有把 Codex 桌面客户端负责的初始化、事件流和审批生命周期完整迁移过来。

Windows 沙箱首次配置是 Codex 的系统级安全初始化，不是每次使用都要用户手动设置。官方 Windows 客户端也会在第一次需要 Agent 操作时触发一次初始化提示；初始化可能需要 UAC。完成后，配置保存在该 `CODEX_HOME`，后续启动应直接可用。Codex 官方说明有两种实现：优先的 `elevated`，以及权限更弱但可继续工作的 `unelevated`。

参考官方文档：

- [Codex App Server](https://developers.openai.com/codex/app-server.md)：嵌入式客户端的线程、轮次、审批和流式事件接口。
- [Windows sandbox](https://developers.openai.com/codex/windows.md)：`elevated` / `unelevated`、首次初始化和故障处理。
- [Agent approvals & security](https://developers.openai.com/codex/sandbox.md)：沙箱边界与审批策略的关系。

## 本次复核发现并已修复

### 1. 事件流会漏读，导致“发送后像死掉了”

原来的 `EngineSession::take_pending()` 只读取内存数组。`call()` 收到 `turn/start` 响应后就返回，而紧接着到达的 `turn/started`、`item/agentMessage/delta`、审批请求和 `turn/completed` 仍在 stdout reader 的 channel 中，轮询无法拿到它们。这个问题会表现为输入框一直忙、审批卡片不出现或 Agent 没有最终状态。

现在每次取事件都会先非阻塞地排空 reader channel，并保留顺序。测试桩覆盖了“响应后紧跟通知和审批”的场景。

### 2. Windows 沙箱原来只发起了 setup，没有等待结果

原实现调用 `windowsSandbox/setupStart` 后立即把控制权交给用户，但官方协议明确说明该请求异步完成，最终结果通过 `windowsSandbox/setupCompleted` 通知返回。现在第一次建立 Agent 线程前会：

1. 调用 `windowsSandbox/readiness`；
2. 未就绪时自动尝试 `elevated`；
3. 等待完成事件；
4. elevated 失败时自动尝试 `unelevated`；
5. 两者都失败时仍允许只读对话，并把限制明确显示给用户。

这意味着用户不需要先找到一个“沙箱设置”页面。第一次可能出现一次 Windows UAC 或系统策略提示，这是操作系统安全边界的初始化，无法由普通应用无提示地替代。之后不应每次重新配置。

当前打包的 `codex-cli 0.158.0` 已用隔离 `CODEX_HOME` 做过协议探针：返回 `notConfigured`，调用 `windowsSandbox/setupStart`（unelevated）返回 `started: true`，随后收到 `windowsSandbox/setupCompleted { success: true }`。该探针没有使用用户凭据，也没有连接模型服务。

### 3. 配置刷新会覆盖 Codex 的 Windows 配置

Scientify 每次建立线程都会重写 `config.toml`。原实现会抹掉 Codex 沙箱初始化写入的 `[windows]` 段，导致“明明配置过，重启又只读”。现在刷新模型服务配置时保留既有 `[windows]` 段，并有 Rust 回归测试。

### 4. 权限审批卡片缺少 `item/permissions/requestApproval` 的回应

Codex 的权限请求不是 `{ decision: ... }`，而是 `{ permissions, scope }`。原 UI 只显示“不支持”，用户无法完成任务。现在卡片提供“允许本次权限”“拒绝权限”“中止任务”，前两者发送正确的权限画像响应。

### 5. 缺少本地 Codex 的中止能力

新增 `agent_interrupt`，对应 `turn/interrupt`，并在 Agent 工作状态旁提供“中止任务”。中止只结束当前轮次，保留线程历史。

## 仍然存在的产品/工程边界

这些不是 Windows 沙箱提示可以解决的问题，后续要单独处理：

1. **当前会话索引仍是一个项目/域一个活跃线程。** `literature` 和 `code` 使用不同的 `CODEX_HOME`，项目之间也按 key 分开；但 AI 面板原有的“历史对话”是 Scientify 自己的 `sessions`，尚未与 Codex `thread/list` / `thread/resume` 完整一一映射。点击“新建 AI 对话”目前不能恢复一个已保存的 Codex 线程。若要完全复刻本地 Codex，需要建立 `conversationId ↔ threadId` 索引，并使用 `thread/resume`。
2. **隔离是工作区/配置/线程隔离，不是绝对的记忆保密。** 同一线程会记住此前轮次；`workspace-write` 限制写入根目录，但不能把“读取所有文件”理解成只读当前打开的 PDF。UI 应显示当前绑定的真实根路径，并在跨域时显式切换。
3. **Agent 直接删除 PDF 不会自动调用 Scientify 文献库的级联删除。** UI 的“移入回收站”已经通过 `LocalLibrary::delete_inner` 将 PDF 与关联 `.notes.md` 成对处理并有 Rust 测试；Codex 通过 shell 删除文件时会绕过这条业务逻辑。后续应提供一个受控的 Scientify 文献工具（或文件删除拦截），让 Agent 删除文献时走同一事务。
4. **审批不是“所有写操作都必然弹卡片”。** `approvalPolicy = on-request` 由 Codex 根据沙箱和策略决定何时询问；工作区内允许的读写可能自动执行，越出边界、网络和额外权限才会请求审批。宿主必须持续读取所有 server request，不能只识别三种审批。
5. **当前内置模型协议仍只接受 OpenAI Responses 形状的 `openai` / `ollama` 配置。** Anthropic、Gemini 等原生协议不能直接交给 Codex，需要在 Scientify 内增加 Responses 适配代理或明确提示“当前服务商只能用于普通 Chat”。endpoint 也应针对 Ollama 统一 `/v1` 约定。
6. **当前消息流只展示 Agent 文本增量。** 命令执行、文件 diff、工具输出、计划和失败详情尚未做成完整的可审阅时间线；这会影响用户判断 AI 改了什么，不能以“文本回复出现”作为完整验收。

## 用户验收路径

1. 打开 Scientify，进入一个已经关联项目目录的页面；不要切换 Chat/Agent，输入“列出当前工作区根目录下的文件”。
2. 第一次发送时，观察是否自动触发一次 Codex Windows 沙箱初始化。允许 UAC（如果系统弹出），等待窗口内回到可输入状态。
3. 再发送“创建一个空的 `agent-smoke.txt`，写入 `Scientify agent smoke test`”。预期：Agent 自己判断需要写文件；若 Codex 请求审批，窗口内显示审批卡片；允许后文件出现在当前项目根目录。
4. 发送“读取刚才的文件并删除它”。预期：删除动作要有审批/状态反馈，任务结束后输入框恢复。文献 PDF 删除仍应通过文献库 UI 验证 PDF 与 `.notes.md` 一起进入回收站。
5. 点击“中止任务”验证 `turn/interrupt`，确认可以继续发送下一条消息。
6. 关闭并重新打开应用，确认同一域无需再次输入 API key，也不重复要求沙箱初始化。

## 验证记录

- `pnpm check`：通过。
- `pnpm test -- --maxWorkers=2`：35 个文件、151 项通过。
- `cargo test -p scientify --lib agent --locked`：16 项通过。
- `cargo fmt --all -- --check`：通过。
- sidecar 协议探针：`codex-cli 0.158.0`；隔离 home 的 readiness/setup/完成事件链通过。
- 尚未完成：真实模型服务下的文件写入、审批、长任务中止和完整桌面 UI 验收；这些需要用户本机的模型服务和一次 Windows 系统初始化。
