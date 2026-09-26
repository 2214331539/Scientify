# Scientify · 第一轮 MVP

本地科研工作台。采用 Left Rail + Main Workspace + Optional Panel，左侧 48px 图标导航提供 Overview、Literature、Notes、Experiments、Paper、Files 六个入口。首页呈现真实的继续工作与最近记录；AI 启动时关闭，通过右下角底栏图标按需打开。研究笔记在中央和侧栏复用同一编辑实例。

技术栈：Tauri 2 / Rust、React 19 / TypeScript、Vite 6、Zustand 5、CodeMirror 6、PDF.js。当前沿用 schema 3 的本地 JSON 存储，保留旧记录与扩展字段。

## 启动

双击 **Scientify-MVP.cmd** 即可运行桌面版，无需启动开发服务器。脚本从 `target/release/` 与 `target/ui-shell/release/` 中选择修改时间最新的 release，没有 release 时回退到 debug。需要 Windows WebView2 Runtime；若旧窗口仍打开，请先关闭旧窗口再启动新版，避免单实例机制只唤起旧界面。两处 release 使用相同的应用标识和数据目录。

桌面版使用单一主 Topbar，集成拖动、双击最大化及最小化 / 还原 / 关闭按钮，关闭操作保留未保存保护。项目管理页仅显示空间侧栏，设置与数据入口位于侧栏底部；进入项目后显示六入口 Rail。

桌面版采用两个独立窗口：启动显示 1100×740 的 Projects 管理窗口；打开项目后创建最大化 Workspace，载入后隐藏 Projects。点击工作区左上角品牌入口或关闭工作区会经过未保存检查，再返回并刷新 Projects；关闭 Projects 退出应用。首版同时保留一个工作区，可在其中切换项目。浏览器预览仍为单窗口。

顶栏保留太阳/月亮按钮直接切换亮暗，按钮不使用常驻选中底色。侧栏「设置」打开固定尺寸的分类弹窗：通用（语言、个人资料）、外观、数据与备份、关于。中英语言在「通用」中选择；跟随系统主题在「外观」中选择。顶部搜索框已移除，工作区搜索可通过 Ctrl+K 打开。偏好立即生效、自动记忆，并在 Projects / Workspace 间同步；不翻译研究内容，不清空草稿。设备偏好独立于工作区 JSON；首次升级沿用原主题。

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
| 项目管理 | 新建、编辑、目录关联、收藏、归档、搜索，个人与团队分类 |
| 项目概览 | 项目研究方向、继续工作、最近材料更新、下一步待办 |
| 文献 | 左侧资源树、PDF 导入/搜索/信息管理；右侧多标签阅读、新增空白页、翻页缩放及阅读位置恢复；订阅边栏暂留空 |
| 实验 | 项目文件树、代码编辑、保存、重读、冲突提示与另存副本、Git 变更查看、实验参数/指标/结论记录 |
| 论文 | Markdown / LaTeX / BibTeX 等文本编辑，Markdown 源码/分栏/预览，项目文献引用信息 |
| Notes / Files | 项目笔记的中央编辑入口；复用现有文件能力的全项目文件视图 |
| 全局辅助 | 项目笔记与个人收集箱、自动保存、来源返回；Ollama / OpenAI 兼容模型提问、对话记录、回答转笔记 |
| 全局操作 | 项目/文献/笔记搜索，主题偏好，数据导入/导出/恢复，可拖动侧栏 |

典型流程：创建项目 → 导入 PDF → 阅读并记录带来源的小结 → 编辑实验文件并记录结果 → 撰写 Markdown 草稿。右侧笔记和 AI 在这些步骤间保持可用。

## AI 配置

打开右下角「AI 助手」图标 →「模型设置」，选择 Ollama 或 OpenAI 兼容服务，填写服务地址和服务中已有的模型名称。远程密钥服务使用 HTTPS；本机开发服务可使用 localhost HTTP。

密钥仅驻留当前打开的面板会话，不写入工作区 JSON。发送前可展开「当前材料」查看将附带的正文，或关闭附带材料。PDF 发送当前页/选区，文件发送当前文件/选区；每次消息保留发送时的材料快照。首版等待完整回答，不支持流式生成与取消。

## 数据与文件

- debug 开发构建：仓库 `.tauri-data/workspace/`。
- 本次 release 构建：`%APPDATA%/com.scientify.desktop/workspace/`。
- Electron 旧目录：`%APPDATA%/scientify-desktop-sample/workspace/`。
- debug 验收可设置 `SCIENTIFY_DATA_DIR` 为独立绝对目录，release 忽略此变量。

未关联项目目录时，文件存放在数据目录的 `projects/<projectId>/`。关联目录后直接编辑该目录中的文件。PDF 导入时复制到 `assets/pdf/`。文本保存保留最近磁盘版本至 `recovery/files/`，并校验外部修改；冲突时可另存副本或确认重新读取。

**JSON 导出不包含 PDF 和源码。** 完整备份需要在应用关闭后复制整个数据目录，以及项目另外关联的目录。数据导入前保留原记录备份；恢复最近备份会保留当前主文件。文件备份不会随着元数据恢复自动回滚。

迁移旧应用时，先关闭 Electron，在「数据与备份」选择「复制旧数据」。只支持迁入空的新数据目录；源数据不修改，两版之后各自独立。

从 debug 切换到本次 release 时，两者的数据目录独立。如果需要保留 debug 中的项目，请先关闭所有 Scientify 窗口并备份两个目录，再将 `.tauri-data/workspace/` 的完整内容复制到**空的** `%APPDATA%/com.scientify.desktop/workspace/`。目标已有项目时不要覆盖或合并；JSON 导出仅适用于元数据迁移，不会携带 PDF 和源码。关联在外部目录的项目文件仍留在原位置。

## 当前边界

- 团队空间为本机分类，无账号登录、多人同步或权限系统。
- 实验状态/指标手动记录；尚无终端、进程执行、调度、运行日志采集。
- Git 仅查看状态；LaTeX 可编辑但未接入编译；Markdown 已提供实际预览。
- 文献订阅入口目前为空白边栏，已有订阅数据与 arXiv 后端接口保留，等待后续完善。无后台自动订阅、实时翻译、PDF 批注和 OCR。
- 未接入文件监听；外部修改可通过重读获取，保存时冲突校验防止覆盖。
- 本机 UTF-8 文本限 2 MiB，PDF 限 100 MiB；浏览器 PDF 预览限 25 MiB。
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
  components/navigation/  六个 Rail 入口与二级视图配置
  components/workspace/   Section / ResourceList / ActivityList / TreeView / WorkspaceFrame
  components/ai/          当前上下文、辅助操作与项目提问输入区
  app/                    应用装配、导航、关闭保护
  shell/                  全局辅助栏、分隔拖动、布局
  workspaces/             overview / literature / files / experiments
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

最新页面结构以 [前端工作区重构：第一阶段](docs/架构设计/前端工作区重构-第一阶段.md) 为基础。旧四入口布局规则已由六入口 Rail 取代；本轮已将页面控件迁入共享 primitive，并统一分区、列表、活动与文件树。组件边界、组合方式与样式约束见 [Workspace UI](src/components/README.md)。现有数据和业务能力沿用。

本轮验证记录见 [UI Shell 第一阶段验收](docs/开发记录/UI-Shell第一阶段验收.md)。

组件体系的最新交付与检查见 [UI 组件体系重构验收](docs/开发记录/UI组件体系重构验收.md)。
