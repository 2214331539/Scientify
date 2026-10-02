# Agent Harness 验收计划

本文规定内置 Agent 引擎的验收方式。设计与接口见 [Agent Harness 集成设计](Agent-Harness-集成设计.md)；实施阶段沿用该文档第 10 节的 M1 / M2 / M3 划分。

文档状态：M1 部分项已验证，其余为待验收。每次验收在文末记录结果与证据路径。

## 2026-10-01：本地并行会话实施与验收

本轮只完善 Agent 会话与任务管理。不包含文献语料库、证据到论文闭环和云端执行。下文早期 M1/M2 记录保留为历史证据；涉及会话粒度、配置下传及后台生命周期时，以本节为准。

### 实现规则

- 全局 AI 入口保持不变，模型服务商配置仍位于侧栏。新对话默认采用当前页面对应目录，可在首次发送前选择「文献目录 / 代码目录」。第一次发送后绑定固定，切换导航页不会改绑旧对话。来自另一执行域的当前材料不会自动附加。
- 执行单元是「项目 ID + 会话 ID」。每个会话有自己的 Codex 进程、线程、命令锁、审批队列和当前 turn；同一会话一次运行一项任务，不同会话及不同项目可以并行。初始化共享引擎数据目录与 Windows 沙箱时串行，模型执行期间不持有全局锁。
- 前端 [AgentRuntime](../../src/features/assistant/agent-runtime.ts) 独立于面板挂载。切页、收起侧栏、切到另一对话不会结束任务。事件唤醒合并为一次读取，700 ms 轮询用于遗漏唤醒的恢复；流式文本只更新内存，结束时再保存。不是每个 token 保存一次工作区。
- 模型参数通过每个进程的 `-c` 覆盖项传入，密钥经进程环境传递。不会为切换一个模型反复覆盖共享 `config.toml`，也不会重启其他会话。沙箱配置仍由 Codex 保存在域的数据目录。显式关闭 Codex `memories` 与 `external_agent_memory_import`，避免在共享引擎数据目录中生成或导入跨线程记忆。
- 线程绑定放在 `<当前数据目录>/agent/bindings/<projectId>/<conversationId>.json`，记录规范化目录、域与引擎线程。`thread/resume` 只采用本机索引，不接受导入 JSON 中任意指定的线程。目录变更后旧会话拒绝重新绑定，应新建对话。空闲 60 秒回收进程，下次发送恢复原线程；从未发送到引擎的空线程不作为可恢复历史。
- 旧版对话没有原生线程索引时，首次创建线程只带入当前会话最近 24 条、最多 24,000 字符的文本历史。其他会话的记录不参与；恢复已有原生线程时不重复注入。
- 中止只作用于指定会话的 `threadId + turnId`。引擎确认收到中止请求后显示「正在中止」，收到实际完成事件才解除运行状态。审批始终内联。目录内常规操作采用 Codex 的 `on-request` 策略，只有引擎请求授权时才显示审批，并非每次写文件都弹窗；尚未支持的其他引擎交互会明确提示，并允许中止。
- 结果按线程与 turn 的稳定消息 ID 保存；保存失败保留内存结果、提供重试，不再次发送模型请求。重试会先读取最新已保存元数据，避免另一窗口更新版本后永久陷入旧 revision 的重试。最新任务的状态、错误、模型与执行记录摘要随对话持久化，最多保留最新 20 个操作及每个操作末尾 4,000 字符。完整原始历史由 Codex 自己保存。
- 上次异常退出留下的「运行中」记录显示恢复连接入口；连接会读取已有引擎结果，不会自动重放用户任务。关闭窗口前要求结束任务并保存结果；退出整个应用后不提供后台常驻执行。普通导航不使用全局 dirty 锁。
- 执行期间阻止删除运行中的对话、删除对应项目、更换项目/文献根及导入替换工作区。原生层同时检查其他窗口发起的删除和替换。重命名对话可正常进行，后台结果保存不会覆盖新名称。

线程历史隔离不等于文件副本隔离：同目录的多个会话看见同一份磁盘文件，本轮不提供 Git worktree、文件事务锁或自动合并。验证并行时让不同会话写不同文件；若需要同时改同一文件，应先串行安排该部分。工作区写入边界仍由 Codex 沙箱与审批决定，不能把线程隔离宣称为任意本机文件的严格读取隔离。

### 自动验证

- [任务管理回归](../../src/features/assistant/agent-runtime.test.ts)：同目录并行、跨项目保存、后台重命名、失败重试、目录/删除保护、恢复历史、空闲回收。
- [协议状态回归](../../src/features/assistant/agent-session.test.ts)：迟到事件过滤、完整消息覆盖流式片段、中止确认与结束区分、并发事件读取合并、审批归属。
- [界面回归](../../src/features/assistant/AssistantPanel.test.tsx)：运行中创建第二条对话、切页保持目录、单独中止、面板卸载后两条结果分别持久化；已有重命名、删除、模型与密钥测试继续覆盖。
- Rust：线程注册表持久化与目录校验、每会话锁不阻塞其他会话、模型参数隔离、事件队列、生成 ACL。`agent_release` 已覆盖 main/workspace 本地来源允许及外部来源拒绝。
- [真实引擎协议验证](../../scripts/verify-agent-harness.mjs)：执行 `node scripts/verify-agent-harness.mjs`。使用打包的 Codex、独立临时目录及本机模拟 Responses 服务，验证两个真实 sidecar 的不同模型配置、并行流式输出、单独中止、进程重启后的原线程恢复。不使用真实密钥，不运行用户目录中的命令。该检查不替代真实服务商、Windows 权限及原生界面的手动验收。

本轮验证结果（2026-10-01）：前端全量 36 个测试文件、167 项通过；Rust 默认及 `custom-protocol` 配置均通过 69 项；TypeScript、Prettier、rustfmt、Clippy 通过。真实 Codex + 本机模拟服务的并行 / 流式 / 单独中止 / 重启恢复验证通过。340 px 侧栏已用真实 React 组件和临时测试数据检查，单独停止后另一条任务仍显示运行，输入区与目录信息没有挤压。真实服务商及 Windows 文件写入的人工验收尚待执行。`pnpm tauri build --no-bundle` 已成功生成 `target/release/scientify.exe`，同目录包含 `codex.exe`。

### 用户手动验收顺序

在两个临时项目中验收，模型服务商从 AI 侧栏配置。

| 步骤 | 操作 | 应有结果 |
| --- | --- | --- |
| 1 | 项目 A 新建对话，选择代码目录，要求读取目录后生成 `agent-a.md` 并说明内容 | 绑定路径可见，输出持续更新，发送键变成停止键，可展开执行记录 |
| 2 | A 尚在执行时点「+」，再要求生成不同的 `agent-b.md` | 新对话可输入和发送，A 出现在后台任务条，两条任务可同时推进 |
| 3 | 切回 A，点击停止 | A 显示正在中止，随后已中止；B 持续运行且最终结果只进入 B |
| 4 | B 运行时切换导航页并收起 AI，再展开 | 页面仍可操作，B 没有重建、丢失或串到另一会话；原目录绑定不变 |
| 5 | 项目 B 发起任务，再回项目 A | 两个项目任务独立，回答、审批与中止均不串项目 |
| 6 | 一条任务等待权限审批，另一条继续执行 | 审批在对应会话内联显示，批准或拒绝只影响该会话 |
| 7 | 后台任务执行期间重命名会话，完成后检查历史 | 新名称保留，助手回答只保存一份；右键删除运行任务被阻止 |
| 8 | 一条任务运行时，在新会话选择不同模型发送 | 已运行任务继续使用原模型；新任务使用新配置 |
| 9 | 完成后等待超过 60 秒，再在原会话询问刚才处理的内容；正常关闭后重开继续 | 恢复原线程历史，不新开丢失记忆的线程；异常中断记录提供恢复连接 |
| 10 | 任务运行时尝试关闭窗口、删除项目或更换执行根 | 明确提示先结束任务并保存结果，任务仍可回到助手中处理 |

此轮开发验证使用临时数据。真实服务商的文件写入、权限提升和 Windows 原生窗口体验仍须按上表人工验收；不把 mock 测试或只读协议验证标记为该部分通过。

## 1. 范围与前置

验收对象是「用户自配模型服务商 + 产品内置执行引擎」这条链路，不包含模型服务质量评价。

前置条件：

1. 已运行 `pnpm install`；`scripts/prepare-agent.mjs` 已把引擎放入 `src-tauri/binaries/`。
2. 验证桌面行为时使用 `pnpm start`；`pnpm dev` 的浏览器预览没有本地引擎，只用于界面与类型检查。
3. 验收产生的数据位于独立目录，不写入日常使用的桌面资料。

## 2. 分层验收

### 2.1 引擎分发（M1）

| 编号 | 验收目标 | 操作 | 通过标准 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | 拉取脚本可独立运行 | `pnpm run prepare:agent` | 输出引擎版本与体积；重复执行时跳过下载 | 已验证 |
| D2 | 产物可执行 | 对 `src-tauri/binaries/codex-*.exe` 执行 `--version` | 输出形如 `codex-cli <版本>` | 已验证 |
| D3 | 版本锁定 | 查看 `src-tauri/binaries/codex.version` | 与 `scripts/prepare-agent.mjs` 中的常量一致 | 已验证 |
| D4 | 不进版本库 | `git status --short` | 不出现 `src-tauri/binaries/` 下的文件 | 已验证 |
| D5 | 打包包含引擎 | `pnpm tauri build --no-bundle` 后检查输出目录 | 引擎与应用可执行文件同目录，且三重后缀已去除 | 已验证（2026-09-29 构建） |
| D6 | 许可证随附 | 检查 `THIRD_PARTY_NOTICES` 与「关于」页面 | 含引擎的 `LICENSE` 与 `NOTICE` | 待办 |
| D7 | 协议类型生成 | `pnpm run prepare:agent` | 生成 `src/generated/agent-protocol/`，含 `index.ts`；重复执行时按版本戳跳过 | 已验证 |

网络要求：本机若只有 WinINET 代理，Node 的 `fetch` 与 `curl` 均不走该代理。脚本在 Windows 上固定使用 PowerShell 的 `Invoke-WebRequest`，它读取系统代理设置；非 Windows 使用 `curl`。

生成的协议类型是派生代码，不进入版本库。它的用途是让字段名可以被核对：`src/platform/agent.ts` 按本仓库既有约定手写接口（与 `platform/research.ts`、`platform/library.ts` 一致），生成树用于编写时对齐与后续对账测试，不直接 import，以免 `pnpm check` 依赖生成步骤。

### 2.2 引擎握手（M1）

| 编号 | 验收目标 | 操作 | 通过标准 | 状态 |
| --- | --- | --- | --- | --- |
| H1 | Rust 侧可编译 | `cargo check -p scientify --locked` | 通过 | 已验证 |
| H2 | 协议层单元测试 | `cargo test -p scientify --lib agent --locked` | 4 项通过 | 已验证 |
| H3 | 引擎状态命令 | 桌面端调用 `agent_status` | 返回 `available: true`、引擎绝对路径与版本 | 待验收 |
| H4 | 握手成功 | 桌面端调用 `agent_handshake` | 返回 `userAgent`、`codexHome`、`platformFamily`、`platformOs` | 待验收 |
| H5 | 握手不开启实验面 | 检查请求体 | `capabilities.experimentalApi` 与 `requestAttestation` 均为 `false` | 已验证（单元测试） |
| H6 | 引擎缺失时可恢复 | 临时移走引擎后调用 `agent_status` | 返回 `available: false`，不抛异常、不崩溃 | 待验收 |
| H7 | 静默引擎不阻塞 | 让引擎不响应后调用 `agent_handshake` | 20 秒内返回超时提示 | 待验收 |

### 2.3 线程与轮次（M1）

| 编号 | 验收目标 | 操作 | 通过标准 | 状态 |
| --- | --- | --- | --- | --- |
| T1 | 命令已登记 | 检查 `lib.rs`、`build.rs`、`capabilities/main.json` 与生成的 `permissions/autogenerated/` | Agent 的线程、轮次、事件、审批、沙箱 setup 和中止命令均存在 | 已验证 |
| T2 | 编译与单元测试 | `cargo test -p scientify --lib agent --locked` | 16 项通过 | 已验证 |
| T3 | 线程建立 | 桌面端对文献域调用 `agent_start_thread` | 自动检查沙箱；首次未配置时自动触发 Codex setup 并等待完成，随后返回 `threadId`；`cwd` 等于文献根；`model` 与 `modelProvider` 非空。初始化失败时仍可读，但明确显示只读原因 | 待验收 |
| T4 | 指令来源可见 | 查看 T3 返回的 `instructionSources` | 能反映引擎实际加载的 `AGENTS.md` 等指令文件路径 | 待验收 |
| T5 | 轮次执行 | 对 T3 的线程调用 `agent_start_turn` | 返回 `turnId`；引擎在文献根内产生文件变更 | 待验收 |
| T6 | 审批默认开启 | 观察 T5 期间的行为 | 文件写入与命令执行走审批请求，不静默执行 | 待验收 |
| T7 | 沙箱限定 | 让任务尝试写入根目录之外 | Windows 沙箱为 `ready` 时被拒绝或转为审批请求，不越界写入；若自动初始化失败，应用必须明确保持只读，不能把降级误报成可编辑 | 待验收 |
| T8 | 未配置服务商 | 未配置模型时调用 `agent_start_turn` | 返回可读错误；应用与引擎进程均不崩溃 | 待验收 |
| T9 | 会话复用 | 同一项目同一域连续两次建立线程 | 复用同一引擎进程，线程可继续 | 待验收 |
| T10 | 双域隔离 | 分别建立文献域与代码域线程 | 两个独立进程，工作目录分别为文献根与项目根 | 待验收 |
| T11 | 审批不丢 | 桩引擎测试 | 通知与审批请求被保留、保持顺序、不被误认为响应 | 已验证 |
| T12 | 审批往返 | 桩引擎测试 | 回应后引擎收到同一 id 的决策 | 已验证 |
| T13 | 决策词正确 | `pnpm vitest run src/platform/agent.test.ts` | 使用 `accept` / `decline` / `cancel`；`cancel` 与 `decline` 区分 | 已验证 |
| T14 | 事件唤醒与恢复 | 桩引擎测试 | 响应后追发的事件进入 reader 队列并触发 `agent-event` 唤醒；`agent_events` 仍可排空恢复队列，事件不会丢失 | 已验证 |
| T15a | 配置写入引擎 | `cargo test -p scientify --lib agent --locked` | `config.toml` 含 model / model_provider / base_url / wire_api；密钥不入文件 | 已验证 |
| T15b | 协议支持范围 | 同上 | `openai` 与 `ollama` 接受；`anthropic` 与 `gemini` 在启动前被拒并给出原因 | 已验证 |
| T15c | 面板接线 | 在 AI 面板配置服务商后建立线程 | 面板把当前设置传给 `agent_start_thread` | 已验证（静态） |
| T15d | 换配置重启 | 更换服务商后再次建立线程 | 引擎以新配置重启，旧进程被回收 | 待验收 |
| T16 | 密钥持久化 | 保存一次密钥后重启应用 | 面板自动回填该端点已存的密钥，无需重输；`<data>/credentials.json` 含该端点的条目 | 待验收（实现见结果记录） |
| T17 | 密钥按端点隔离 | 同一协议的两个端点各存一次密钥 | 两条记录互不覆盖；切到另一个端点不会沿用上一个密钥 | 待验收（实现见结果记录） |

关于 T15：模型配置已存在于侧边栏 AI 面板（`features/assistant/ModelSettingsDialog`，仅由 `AssistantPanel` 引用，不在全局设置中）。引擎侧的下传已实现：`src-tauri/src/agent/config.rs` 生成 `config.toml`，其中只写环境变量名 `SCIENTIFY_AGENT_KEY`，密钥通过该变量传给子进程；`agent_start_thread` 现在要求传入连接信息，并在配置变化时重启进程。密钥本身另存于 `<data>/credentials.json`（见设计文档 §4.7），不进入 `config.toml`，也不进入 `workspace.json`。

两点边界必须记住：

1. **引擎只认 OpenAI Responses 协议。** `anthropic` 与 `gemini` 在启动前就被拒绝并说明原因，因为它们的线格式不同。要让它们可用需要一层协议转换，本项目暂不提供。
2. **面板已接线（T15c）。** `AssistantPanel` 打开本地执行模式后，用当前设置构造 `AgentConnection` 并交给 `AgentSession`。该结论来自类型检查与既有测试，尚未在真实服务商下端到端执行。

关于 T11–T14 的说明：

1. 引擎在同一个时间片里可能先回响应、再发通知与审批。宿主在看到自己的响应后就返回，因此尾随事件由 reader 保存在 session 队列，并通过 `agent-event` 唤醒前端；`agent_events` 仍作为恢复接口。桌面端不依赖 SSE，浏览器预览则使用低频恢复轮询。
2. 审批请求必须被回答，否则轮次阻塞。`EngineSession` 因此把非响应的消息排队而不是丢弃。
3. 决策词属于传输层，由 `platform/agent.ts` 组装，Rust 侧只做透传，`RequestId` 原样回显（它可以是字符串）。
4. T11–T14 用桩引擎验证客户端侧的框架正确性，**不证明真实引擎会在预期时机发出审批**。后者依赖 T6/T7，需要配置模型服务商。

### 2.4 域绑定（M1）

| 编号 | 验收目标 | 操作 | 通过标准 | 状态 |
| --- | --- | --- | --- | --- |
| B1 | 导航到域的映射 | `pnpm test src/platform/agent.test.ts` | 3 项通过：三个文件视图同为 `code`，文献为 `literature`，无根视图为 `null` | 已验证 |
| B2 | 文献域解析 | 打开文献文件夹后调用 `agent_domains` | `literature.root` 为真实文献根路径 | 待验收 |
| B3 | 代码域解析 | 关联项目目录后调用 `agent_domains` | `code.root` 为项目文件根路径 | 待验收 |
| B4 | 未挂载文献时不回退 | 未打开文献文件夹时调用 | `literature.available` 为 `false`，`reason` 可读，不回退到代码根 | 待验收 |
| B5 | 个人作用域无引擎 | 无项目时打开 AI 面板 | 绑定选择器置灰并说明原因 | 待验收 |

### 2.5 命令登记一致性（M1）

| 编号 | 验收目标 | 操作 | 通过标准 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | 三处同步 | 对比 `lib.rs` 的 `invoke_handler`、`build.rs` 的 `AppManifest`、`capabilities/main.json` | 七个 agent 命令与三个 `secret_*` 命令在三处均存在 | 已验证（人工核对） |
| C2 | 越权视图被拒绝 | 从非本地视图调用 agent 命令 | 返回不可用错误 | 待验收 |
| C3 | 对账测试 | 后续补充的自动化检查 | `invoke_handler` 与 `allow-*` 不一致时失败 | 待办 |

### 2.6 前端入口（M2）

| 编号 | 验收目标 | 通过标准 |
| --- | --- | --- |
| F1 | 绑定选择器 | 顶部显示当前域与根目录摘要；切换域时线程切换且对话不清空 |
| F2 | 无根提示 | 文献未挂载或个人作用域下，选择器不可用并给出原因 |
| F3 | 中断 | 任务进行中可中断，界面回到可输入状态 |
| F4 | 审批卡片 | 命令执行、文件变更、权限提升三类请求都有内联确认，可允许或拒绝 |
| F5 | 工具调用展示 | 读文件、执行命令等步骤在消息流中可见，含结果状态 |
| F6 | 文件变更可见 | 任务结束后可查看被改动的文件并可打开差异 |
| F7 | 导航不中断 | 任务进行中仍可点击页面、切换项目和切换 Scientify 对话；后台 session 继续运行并只更新所属面板 |
| F8 | 草稿冲突 | 目标文件存在未保存草稿时，任务开始前提示先处理 |
| F9 | 脏标记隔离 | Agent 运行态不写入全局 dirty，不会阻塞其他项目的导航 |
| F10 | 浏览器预览 | `pnpm dev` 下 agent 入口给出明确不可用提示，不静默失败 |
| F11 | 清理失联绑定 | 文献目录中 PDF 与 `.notes.md` 均已不存在时，点击“移除失联记录” | 仅移除 `.scientify/library.json` 中的绑定，不删除其他文件；若笔记仍存在则拒绝清理 |

F4 的当前状态：`components/ai/ApprovalCard` 已实现并接入 `AssistantPanel`，通过 4 项组件测试，覆盖命令、文件变更和权限画像三类请求（含「字段全缺」与「`cancel` 与 `decline` 不同」）。权限画像使用 Codex 要求的 `{ permissions, scope }` 响应格式。

F4 与 F7 已在 `features/assistant/agent-session` 实现并通过测试：线程开启、轮次发送、尾随审批的抓取、去重（同一 id 不重复显示）、数字与字符串 id 的匹配、决策回传与清行、完成事件回到空闲、失败时不假装线程存在。中止请求同时携带 `threadId` 与 `turnId`；Agent 运行态不再写入全局 dirty。

两者已接入 `AssistantPanel`：输入框不要求切换「对话 / Agent」，桌面端有项目根且服务商协议受支持时自动走 harness；`agent-event` 唤醒后调用 `agent_events`，将 `agentState.approvals` 渲染为内联 `ApprovalCard` 并回传决策；引擎返回的 Agent 文本增量会即时显示在消息流中；任务进行中可调用携带 `turnId` 的 `turn/interrupt` 中止。当前仍缺少真实服务商下的端到端面板验收。

### 2.7 会话与持久化（M3）

| 编号 | 验收目标 | 通过标准 |
| --- | --- | --- |
| S1 | 线程归属 | 每个项目的线程可由索引还原；跨项目恢复被拒绝 |
| S2 | 不在工作区 JSON 内 | `workspace.json` 不随任务增长；`sessions` 数组不承载引擎事件流 |
| S3 | 索引原子写 | 中断进程后索引仍可解析，或可回退到上一版 |
| S4 | 审计可查 | 每次工具调用有记录，含域、线程、目标路径或命令摘要、结果 |
| S5 | 双域隔离 | 两个域的线程历史、配置、凭据互不可见 |

## 3. 端到端场景

以下场景跨越多个验收项，建议作为整体回归。

**场景 A：文献任务改文件。** 在文献工作区发起「把这篇 PDF 的摘要写成同名笔记」。预期：绑定显示为文献域与文献根；出现文件写入审批；允许后生成 `.notes.md`；文献库刷新后能看到该笔记；`workspace.json` 体积不变。

**场景 B：代码任务执行命令。** 在实验工作区发起「为这个目录初始化 Python 环境」。预期：绑定显示为代码域与项目根；出现命令执行审批；拒绝时不执行且状态可恢复；允许后命令在项目根下执行。

**场景 C：跨域移交。** 在文献工作区要求「写一个分析脚本」。预期：文献域不写入代码根；界面提供显式移交入口，由用户确认后转到代码域。

**场景 D：中断与恢复。** 任务进行中中断，随后重新发起。预期：中断立即生效；会话仍可继续；关闭保护在中断前生效。

**场景 E：引擎缺失。** 移走引擎后打开 AI 面板。预期：明确提示引擎不可用，其余功能不受影响，应用不崩溃。

## 4. 已知边界（不计为失败）

1. 引擎协议仍标记为 experimental，`--listen` 之外的传输与实验性方法不在本次范围。
2. 引擎自身的 analytics 默认关闭，本项目不开启；该行为需要在上游升级后复核。
3. 引擎包含独立的沙箱与命令执行辅助进程，其分布方式随上游版本变化；打包验收（D5）需在每次升级后重跑。
4. 验收不评价模型质量。不同服务商在工具调用上的表现差异属于产品边界，见设计文档第 11 节。

## 5. 结果记录

| 日期 | 范围 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 2026-09-28 | M1 引擎分发与握手 | `pnpm run prepare:agent` | 通过：下载 75.9 MB 压缩包，解压后 309.2 MB，`codex-cli 0.158.0` | `src-tauri/binaries/codex-x86_64-pc-windows-msvc.exe` |
| 2026-09-28 | M1 协议层与域映射 | `cargo test -p scientify --lib agent --locked` | 通过：4 项 | `target/debug/deps/` |
| 2026-09-28 | M1 类型检查 | `pnpm check` | 通过 | — |
| 2026-09-28 | M1 域映射 | `pnpm vitest run src/platform/agent.test.ts` | 通过：3 项 | — |
| 2026-09-28 | M1 协议类型生成 | `pnpm run prepare:agent` | 通过：生成 732 个类型文件 | `src/generated/agent-protocol/` |
| 2026-09-28 | M1 线程与轮次落地 | `cargo check -p scientify --locked`、`cargo test -p scientify --lib agent --locked` | 通过：6 项 | `src-tauri/src/agent/` |
| 2026-09-28 | M1 类型检查（含生成类型） | `pnpm check` | 通过 | — |
| 2026-09-28 | M1 审批链路（客户端侧） | `cargo test -p scientify --lib agent --locked` | 通过：9 项，含桩引擎审批往返 | `src-tauri/src/agent/process.rs` |
| 2026-09-28 | M1 审批决策词 | `pnpm vitest run src/platform/agent.test.ts` | 通过：6 项 | — |
| 2026-09-28 | M2 审批卡片组件 | `pnpm vitest run src/components/ai/ApprovalCard.test.tsx` | 通过：4 项；未接入面板 | `src/components/ai/ApprovalCard.tsx` |
| 2026-09-28 | 模型配置归属核查 | 静态检查 `Settings.tsx` 与 `ModelSettingsDialog` 引用 | 模型配置仅在 AI 面板内；尚未下传引擎（见 T15） | — |
| 2026-09-28 | T15 引擎侧配置下传 | `cargo test -p scientify --lib agent --locked` | 通过：14 项，含 5 项配置用例 | `src-tauri/src/agent/config.rs` |
| 2026-09-28 | T15 前端契约 | `pnpm vitest run src/platform/agent.test.ts` | 通过：7 项；面板待接线 | — |
| 2026-09-28 | M2 会话状态机 | `pnpm vitest run src/features/assistant/agent-session.test.ts` | 通过：8 项 | `src/features/assistant/agent-session.ts` |
| 2026-09-28 | M2 面板接线 | `pnpm check`、`pnpm test -- --maxWorkers=2` | 通过：34 文件 / 144 项；未加面板级回归 | `src/features/assistant/AssistantPanel.tsx` |
| 2026-09-28 | T16 / T17 密钥持久化 | `cargo test -p scientify --lib credentials --locked`、`pnpm vitest run src/platform/credentials.test.ts src/features/assistant/AssistantPanel.test.tsx` | 通过：Rust 3 项（槽位规则、往返写入、损坏文件不静默覆盖）、前端 3 项（槽位规则、浏览器预览不可用、面板回填与按端点归档）；真实桌面端重启回填仍待人工验收 | `src-tauri/src/credentials.rs`、`src/platform/credentials.ts` |
| 2026-09-28 | 全量回归 | `pnpm test`、`cargo test --workspace` | 通过：前端 35 文件 / 149 项；Rust 31 + 13 + 7 + 11 项 | — |
| 2026-09-29 | Agent 启动修复 | 直接检查 `codex.exe app-server --help` 并用 stdio initialize 探针验证 | 确认 Codex 0.158 必须使用 `app-server --listen stdio://`；原实现漏掉子命令，导致子进程立即退出并在写入时产生 Windows `os error 232`。已修正启动参数，并在长连接启动后完成 `initialize` / `initialized` 握手 | `src-tauri/src/agent/process.rs`、`src-tauri/src/agent/protocol.rs` |
| 2026-09-29 | Windows 沙箱探针 | app-server `windowsSandbox/readiness`、`windowsSandbox/setupStart` | 隔离 `CODEX_HOME` 返回 `notConfigured`；`unelevated` setup 返回 `started: true` 并收到 `setupCompleted(success: true)`。首次线程现在自动执行同一流程；真实文件修改仍需桌面端人工验收 | `src/generated/agent-protocol/v2/WindowsSandboxReadiness.ts` |
| 2026-09-29 | Agent 状态与入口修复（历史检查点） | `pnpm check`、`pnpm test -- --maxWorkers=2`、`cargo test -p scientify --lib agent --locked`、`cargo clippy --workspace --all-targets --locked`、`pnpm tauri build --no-bundle` | 通过：前端 35 文件 / 150 项；Rust Agent 14 项；Release 构建成功。该检查点曾使用输入框胶囊切换模式；轮次完成事件会清除运行状态；Agent 文本增量显示在消息流。后续已改为自动路由 | `src/components/ai/AssistantComposer.tsx`、`src/features/assistant/agent-session.ts` |
| 2026-09-29 | 自动 Agent 与沙箱初始化 | `pnpm check`、`pnpm test -- --maxWorkers=2`、`cargo test --workspace --locked`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`pnpm tauri build --no-bundle` | 通过：工作区有根目录时自动进入 harness；首次未配置时自动尝试 elevated/unelevated 并等待完成；PDF 删除相关 Rust 测试覆盖 PDF 与 `.notes.md` 一起移入回收站。真实服务商下的写入、审批和中止仍待人工验收 | `src/features/assistant/AssistantPanel.tsx`、`src-tauri/src/agent/mod.rs`、`crates/scientify-core/tests/library.rs` |

每次验收后追加一行，并注明未覆盖项；不得用「通过」覆盖未执行的检查。
