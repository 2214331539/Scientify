# Scientify · 第一轮 MVP

本地科研工作台。采用 Left Rail + Main Workspace + Optional Panel，左侧 48px 图标导航提供 Overview、Literature、Notes、Experiments、Paper 五个入口；代码与项目文件从实验、论文视图进入。首页呈现真实的继续工作与最近记录；AI 启动时关闭，通过右下角底栏图标按需打开。研究笔记在中央和侧栏复用同一编辑实例。

技术栈：Tauri 2 / Rust、React 19 / TypeScript、Vite 6、Zustand 5、CodeMirror 6、PDF.js。当前沿用 schema 3 的本地 JSON 存储，保留旧记录与扩展字段。

## 启动

双击 **Scientify-MVP.cmd** 即可运行桌面版，无需启动开发服务器。脚本从 `target/release/` 与 `target/ui-shell/release/` 中选择修改时间最新的 release，没有 release 时回退到 debug。需要 Windows WebView2 Runtime；若旧窗口仍打开，请先关闭旧窗口再启动新版，避免单实例机制只唤起旧界面。两处 release 使用相同的应用标识和数据目录。

Projects 启动页采用左侧品牌/空间导航、右侧搜索与项目书架：默认书本封面网格，可切换列表，支持搜索、收藏、归档、创建、编辑与右键重命名/删除；顶部不显示筛选或排序。头像/登录仅为静态组件。左下角复用工作区的亮暗切换，底部工具仅保留设置和亮暗切换；右上角提供原生窗口操作，关闭继续经过未保存保护。进入项目后显示单行 Topbar 与五入口 Rail。

桌面版采用两个独立窗口：启动显示 1100×740 的 Projects 管理窗口；打开项目后创建最大化 Workspace，载入后隐藏 Projects。点击工作区左上角品牌入口或关闭工作区会经过未保存检查，再返回并刷新 Projects；关闭 Projects 退出应用。首版同时保留一个工作区，可在其中切换项目。浏览器预览仍为单窗口。

Workspace 的顶栏与 Projects 的左下角使用同一太阳/月亮按钮切换亮暗，无常驻选中底色。侧栏「设置」打开固定尺寸的分类弹窗：通用（语言、个人资料）、外观、数据与备份、关于。中英语言在「通用」中选择；跟随系统主题在「外观」中选择。Projects 顶部搜索当前空间的项目；Workspace 的全局搜索通过 Ctrl+K 打开。偏好立即生效、自动记忆，并在两个窗口间同步；不翻译研究内容，不清空草稿。

团队协作空间以侧栏小卡片切换团队、虚线卡片创建团队，支持右键修改/删除；右侧直接显示对应团队项目，项目可在个人/团队空间间调整归属。删除团队会将项目转入个人空间。删除项目先确认，再删除项目及其笔记、实验、任务和对话记录；共享文献移除该项目的关联，磁盘文件、PDF 与本地文献目录保留。在线邀请、同步与账号登录尚未接入。详细记录见 [Projects 启动页重构](docs/开发记录/Projects启动页重构-2026-09-26.md)。

开发环境需要 Node.js 22.14–24、pnpm 10.11.0、Rust stable、MSVC C++ Build Tools 和 WebView2。

```powershell
cd F:\Project\Scientify\Scientify
pnpm install --frozen-lockfile
pnpm start
```

`Scientify.cmd` 启动开发模式。`pnpm dev` 提供 http://127.0.0.1:1420 浏览器预览；预览数据独立保存在浏览器，不读取桌面数据。模型请求、arXiv、Git 和目录关联仅在桌面版可用。

## 本轮能力

| 区域 | 可以完成的工作 |
| --- | --- |
| 项目管理 | 书本封面网格/列表、新建、编辑、删除、目录关联、收藏、归档、搜索；个人与团队空间管理 |
| 项目概览 | 项目研究方向、继续工作、最近材料更新、下一步待办 |
| 文献 | 关联真实目录、递归树与文件名搜索；PDF/相邻 Markdown 笔记配对管理、双标签组、自动保存与冲突保护；原生网页标签与下载；旧资料可显式复制迁移 |
| 实验 | Code 编辑与保存保护、Git 暂存/commit/历史/本地分支/stash/worktree、固定目录的 AI 与并行运行、日志/停止、Runs 指标与产物 |
| 论文 | Markdown / LaTeX / BibTeX 等文本编辑，Markdown 源码/分栏/预览，项目文献引用信息 |
| Notes | 项目笔记的中央编辑入口，与侧栏复用同一编辑实例 |
| 全局辅助 | 项目笔记与个人收集箱、自动保存、来源返回；Ollama / OpenAI 兼容 / Anthropic / Gemini 模型提问、对话记录、回答转笔记 |
| 全局操作 | 项目/文献/笔记搜索，主题偏好，数据导入/导出/恢复，可拖动侧栏 |

典型流程：创建项目 → 导入 PDF → 阅读并记录带来源的小结 → 编辑实验文件并记录结果 → 撰写 Markdown 草稿。右侧笔记和 AI 在这些步骤间保持可用。

产品导航基线（2026-09-30）：直接移除 Files 入口及独立的 All files 功能页面，不保留隐藏页面或替代入口。项目文件树与编辑、保存和冲突保护仍由 Experiments / Code 与 Paper / Manuscript 复用；移除页面不删除用户文件。

产品下一阶段的定位与范围建议见 [产品功能说明](docs/产品功能文档/产品功能说明.md)；各页面的职责、布局、交互和失败状态见 [页面功能与交互设计](docs/产品功能文档/页面功能与交互设计.md)。两份文档是设计建议，不代表新增能力已经交付。

当前各页面和操作入口见 [产品功能入口说明](docs/产品功能文档/产品功能入口说明.md)。本地执行只在桌面版开放；脚本通过 SCIENTIFY_RUN_DIR 写入各次运行的产物目录。

全局 AI 的代码会话可以启动正式实验，聊天关联运行与 Experiments / Runs 使用同一 ID。手动和 AI 正式运行共用内置 Codex 工作区沙箱；日志、结果和来源会话保存在本机。实现与验收见 [全局 AI 与正式实验运行](docs/技术方案/全局AI与正式实验运行集成.md)。

## AI 配置

打开右下角「AI 助手」图标 → 底部模型胶囊 →「配置其他模型」，或从会话顶栏「…」进入「模型设置」。选择 OpenAI、Anthropic、Gemini、DeepSeek、通义千问、Moonshot、硅基流动、OpenRouter、Ollama 或自定义服务商。预设自动填入地址，部分服务可切换区域；自定义服务填写完整 API 基址并选择协议。填写 API 密钥（Ollama 可选），点击「测试连接」获取服务返回的模型列表，从下拉框选择聊天模型后保存。保存前会发送一条简短测试消息验证聊天权限，不携带研究材料；模型胶囊可切换该服务最近获取的模型。无列表接口的服务会明确报错，不使用假模型或要求手填模型名。远程密钥服务使用 HTTPS；本机开发服务可使用 localhost HTTP。

密钥保存在本机数据目录的凭据文件中，不写入工作区 JSON，也不会随项目同步；切换服务商或重启应用后可以继续使用。发送前可展开「当前材料」查看将附带的正文，或关闭附带材料。旧资料 PDF 可发送当前页/选区，文件可发送当前文件/选区；本地文献 v0.4 仅传递文献名称与标识，不将相邻笔记、网页内容或登录会话发送给普通 Chat。Agent 模式由内置 Codex 在绑定的本地工作区执行，文本和审批会流式显示，发送键可中止当前任务。

## 本地文献 v0.4

在桌面工作区打开「文献」，点击文件夹图标选择项目文献目录。目录工具栏位于导航下方，目录树在工具栏下独立滚动。点击搜索或 Ctrl+F 后，同一工具栏整行切换为搜索框，路径与按钮暂时隐藏；Enter 或点击其他区域恢复工具栏并保留筛选，Esc 清除筛选并退出。右键支持配对重命名、移动、复制、回收及重新关联，目录内支持 Ctrl+C/X/V 和拖放。

可从 Windows 文件管理器拖入单个或多个文件：拖到文件夹行时复制到该子目录，拖到空白处时复制到文献根目录，同名自动编号。每个文件限 150 MiB；导入逐文件处理，失败会显示已经完成的数量；暂不支持直接拖入整个文件夹。原 PDF 对话框导入继续可用。

打开 PDF 时，同时打开右侧独立论文笔记。底部“分页阅览 / 连续滚动”按钮切换阅读方式；连续模式用滚轮跨页阅读，页码随位置更新，也可输入页码或使用前后页按钮。切换模式保留当前页，连续模式只渲染视口附近的页面。首次输入笔记内容后才创建 `同名.notes.md`，自动保存，也可 Ctrl+S；选文可摘录并附页码链接。关闭笔记不会删除文件，再次激活已有 PDF 不会强行打开笔记；可通过右键重新打开。外部编辑发生冲突时保留草稿，可重新读取或另存副本。

中央标签栏「+」打开 Google 网页标签，支持网址、Google 关键词搜索、前进/后退、刷新/停止、外部浏览器和原生下载对话框。下载默认目录为当前文献库。网页使用基于 Chromium 的 Windows WebView2 子视图及独立浏览资料目录，无应用 IPC 权限；Google 是默认首页和搜索服务，直接输入网址则访问该网址。设置等弹层出现时隐藏网页。最多 16 个网页标签。

「订阅」目前仅提供浏览器入口，并明确显示推荐与个人信息源尚未启用。「旧资料」保留原元数据文献界面；目录菜单的「迁移旧文献」复制本项目 PDF 和可导出的笔记，保留所有原记录，重复迁移会产生副本。

具体边界、文件协议和验收见 [文献 v0.4 Tauri 交付记录](docs/开发记录/文献模块v0.4-Tauri交付.md)。

## 数据与文件

- debug 开发构建：仓库 `.tauri-data/workspace/`。
- release：安装目录附近的 `ScientifyData/`；本仓库构建统一使用仓库根的 `ScientifyData/`，实际记录在其 `workspace/` 子目录。
- Electron 旧目录：`%APPDATA%/scientify-desktop-sample/workspace/`。
- debug 验收可设置 `SCIENTIFY_DATA_DIR` 为独立绝对目录，release 忽略此变量。

未关联项目目录时，实验/论文文件存放在数据目录的 `projects/<projectId>/`。关联目录后直接编辑该目录中的文件。旧资料 PDF 位于 `assets/pdf/`；新文献目录由 `literature-roots.json` 映射，稳定文献标识保存在文献根目录的 `.scientify/library.json`，笔记与 PDF 相邻。项目文件保存保留最近磁盘版本至 `recovery/files/`；论文笔记使用 revision 冲突保护与原子写入。

**JSON 导出不包含 PDF 和源码。** 完整备份需要在应用关闭后复制整个数据目录，以及项目另外关联的目录。数据导入前保留原记录备份；恢复最近备份会保留当前主文件。文件备份不会随着元数据恢复自动回滚。

迁移旧应用时，先关闭 Electron，在「数据与备份」选择「复制旧数据」。只支持迁入空的新数据目录；源数据不修改，两版之后各自独立。

正式版首次启动会迁移旧 `%APPDATA%/com.scientify.desktop/workspace/` 及对应浏览缓存：先复制、逐文件 SHA-256 校验、更新内部路径与 Codex 历史数据库，再切换位置并清理源目录。目标已有数据时停止，不自动合并。设置 → 数据与备份 → 更改位置，选择空文件夹；迁移在退出后下次启动执行，可以提前取消。应用凭据、托管代码、实验结果、Agent 历史和 WebView2 浏览资料均随应用数据迁移，外部关联目录不移动。

安装位置须可写，应用不会静默回退 C 盘；只读安装位置需要调整目录权限或重新安装到可写位置。`scientify-storage.json` 仅记录当前/待迁移路径，放在安装目录旁，应用数据与该文件已加入 Git 忽略。系统 WebView2 Runtime、用户自行安装的解释器和外部研究目录不属于应用托管数据。

本轮迁移、AI 界面和实际校验见 [存储迁移与 AI 界面整理](docs/开发记录/存储迁移与AI界面整理-2026-10-02.md)；实验下一步的版本管理设计见 [产品页面说明](docs/产品功能文档/实验代码版本管理页面说明.md)。

debug 与 release 的数据独立。迁移开发数据前先关闭应用并备份，再将 `.tauri-data/workspace/` 完整复制到空的正式版 `ScientifyData/workspace/`，不能覆盖或合并既有项目；JSON 导出不含 PDF 和源码。

## 当前边界

- 团队空间为本机分类，无账号登录、多人同步或权限系统。
- 实验支持可展开卡片/列表、多实验 Python 绑定、真实 PTY 终端、venv/已安装 Conda 管理、依赖任务、无需模型的本地运行、独立停止、日志与产物；完整调试/测试发现、远程调度及 Notebook 内核尚未接入。见 [终端与 Python 验收](docs/开发记录/真实终端与Python环境-2026-10-03.md)。
- Git 支持状态、文本 diff、暂存、commit、最近 100 条历史、本地分支、stash、受保护的 restore 与 worktree；尚无远程、merge/rebase/revert 或可视化冲突解决。详见 [实现与验收](docs/开发记录/Git与Worktree集成-2026-10-02.md)。LaTeX 未接入编译；Markdown 已提供实际预览。
- 文献推荐和个人信息源明确显示未启用；已有旧订阅数据与 arXiv 后端接口保留。无后台订阅、实时翻译、PDF 批注和 OCR。
- 本地文献目录已接入文件监听与唯一指纹重关联；实验/论文文件仍需重读获取外部修改。保存均有冲突校验。
- 本机 UTF-8 文本限 2 MiB；新文献 PDF 限 150 MiB，旧附件限 100 MiB；HTTP 预览的 PDF 限 25 MiB。目录最多 10,000 项、32 层。
- 本地文献目录、相邻笔记和原生网页仅在 Tauri 桌面版可用；HTTP 预览保留旧文献 UI。当前全局搜索与首页活动仍基于旧工作区元数据，新目录使用自身搜索。
- 文件事务中断且无法回退时保留 `.scientify/operation.json` 并停止写入；恢复需人工核对清单，尚无自动崩溃恢复界面。
- 未保存的文件草稿保留于当前应用进程，不能保证崩溃恢复；笔记有自动保存及失败重试。
- 本轮提供本机可执行文件；未签名、未发布安装包、未配置自动更新。

## 检查与构建

```powershell
pnpm check
pnpm test
cargo fmt --all --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
pnpm tauri build --debug --no-bundle
pnpm tauri build --no-bundle
```

前端构建自动复制 PDF 字体、CMaps、WASM 和 ICC 资源，不依赖在线 CDN。CodeMirror、PDF 阅读器和论文预览按需加载。格式化命令：`pnpm format`。

本轮 Shell 的独立构建命令如下，输出与 `Scientify-MVP.cmd` 优先启动的路径一致：

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target/ui-shell'
pnpm tauri build --no-bundle
```

## 源码入口

```text
src/
  components/layout/      顶栏、项目切换、整体布局
  components/primitives/  Button / Input / Dropdown / Tooltip / Badge
  components/navigation/  五个 Rail 入口与二级视图配置
  components/workspace/   Section / ResourceList / ActivityList / TreeView / WorkspaceFrame
  components/ai/          当前上下文、辅助操作与项目提问输入区
  app/                    应用装配、导航、关闭保护
  shell/                  全局辅助栏、分隔拖动、布局
  workspaces/             overview / literature / files / experiments（files 为共享编辑模块，不是独立页面）
  features/               projects / literature / assistant / notes / search / settings
  editor/                 文件会话、CodeMirror、Markdown 预览
  reader/                 PDF 阅读器
  domain/                 工作区数据和上下文契约
  stores/                 串行保存、版本控制、数据替换
  platform/               桌面 IPC 与隔离浏览器适配器
  styles/                 语义变量及工作台样式
crates/scientify-core/     存储、校验、受限项目文件访问及测试
src-tauri/                桌面命令、HTTP/Git、权限、打包
scripts/                  PDF 资源准备
```

新工作区提供资源区、中央呈现与 `WorkContext`，通过 `ResearchBackend` 使用本机能力。领域数据经 store 更新；文件内容经文件会话保存；侧栏宽度与阅读位置属于独立 UI 偏好。不要在组件中自行访问磁盘或复制一套 AI/笔记面板。

项目仅维护 Tauri 桌面应用与 React 前端，以 `pnpm-lock.yaml` 为唯一 JavaScript 依赖锁文件。旧 Electron 应用、预览服务、专属测试与构建脚本已移除；Rust 中的旧工作区迁移功能独立保留，不依赖 Electron 运行时或源码。

文档现位于本仓库的 [docs](docs/README.md)。前端开发先读 [UI/UX 标准](docs/UI-UX/README.md)，涵盖视觉、组件、交互、动效与验收；技术方案第 0 节区分当前实现和后续目标。开发记录见 [第一轮MVP交付](docs/开发记录/第一轮MVP交付.md)。

最新页面结构以 [前端工作区重构：第一阶段](docs/架构设计/前端工作区重构-第一阶段.md) 为基础。当前采用五入口 Rail，不再保留 Files 独立页面；旧四入口布局与六入口交付记录均不作为当前导航要求。本轮已将页面控件迁入共享 primitive，并统一分区、列表、活动与文件树。组件边界、组合方式与样式约束见 [Workspace UI](src/components/README.md)。现有数据和业务能力沿用。

本轮验证记录见 [UI Shell 第一阶段验收](docs/开发记录/UI-Shell第一阶段验收.md)。

组件体系的最新交付与检查见 [UI 组件体系重构验收](docs/开发记录/UI组件体系重构验收.md)。

共享按钮、菜单、设置选择器、弹窗、树箭头与辅助栏使用统一动效，尊重系统“减少动态效果”；规范见 [UI/UX](docs/UI-UX/03-交互与动效.md)。
