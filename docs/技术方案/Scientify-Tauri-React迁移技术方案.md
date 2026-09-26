# Scientify 桌面技术栈迁移方案

> 2026-09-24 更新：已全面转向 Tauri，旧 Electron 源码、依赖与 `legacy:*` 入口已删除。下文路径和回退说明仅记录迁移历史；旧数据复制仍由 Rust 实现。

> 本文保留为早期 Electron → Tauri 迁移记录。后续开发以 [技术方案](../架构设计/技术方案.md) 为准；其中明确了四个工作区、全局辅助栏及独立的 SQLite 迁移阶段。本文件的 JSON 阶段约束不代表长期存储决策。

日期：2026-09-23。状态：方案确定，M1 开始实施。目标仓库：`F:\Project\Scientify\Scientify`。

## 1. 决策与边界

唯一目标架构为 **Tauri 2 + Rust + React 19 + TypeScript 5 + Vite 6 + Zustand 5 + Tailwind CSS 4**。包管理统一 pnpm，Rust 使用 Cargo workspace。Windows WebView2 为首个验收平台。最终安装包不包含 Electron、Node 运行时或 Node sidecar，不将旧渲染器嵌入 React，不保留 HTTP 本地服务作为桌面后端。

本次工作先交付方案和 M1 可运行迁移切片，不把 M1 声称为全量功能迁移完成。后续阶段按本文顺序替换所有现有能力。`产品功能说明.md` 中尚未实现的账号、云协作、SSH、云同步等目标功能不混入此次等价迁移。

参考对象是本机 `F:\Project\Oleafly` 的实际工程，而非同名产品介绍。已核对其 `package.json`、`Cargo.toml`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `vite.config.ts`。参考工程使用 React 19、Tauri 2、Vite 6、TypeScript、Zustand、Tailwind 4、Cargo workspace 和 pnpm。Scientify 独立实现代码，不直接复制 Oleafly 的业务源码、品牌资源、签名密钥、更新地址及 sidecar。参考工程采用 AGPL-3.0-or-later；未来若引入源码，需单独记录来源和相应许可义务。

## 2. 当前架构与行为基线

| 现有位置 | 职责 | 迁移落点 |
| --- | --- | --- |
| `electron/main.cjs` | 窗口、IPC 白名单、文件选择、关闭前保存 | `src-tauri/src/lib.rs`、原生对话框与窗口事件 |
| `electron/preload.cjs`、`renderer/bridge.mjs` | Electron 隔离桥、浏览器 HTTP API | `src/platform/desktop.ts` 显式类型化 invoke |
| `electron/services.cjs` | JSON、附件、Ollama、arXiv、Git、XeLaTeX | `crates/scientify-core` 中按领域拆分的 Rust 服务 |
| `renderer/workspace.mjs` | 全局状态、事件委托、自动保存、导航 | React 功能组件 + Zustand workspace store |
| `renderer/core.mjs` | schema 3 校验、回收站、实验指标、LaTeX | Rust 权威校验；纯前端显示逻辑用 TypeScript |
| `renderer/views.mjs`、`spaces.mjs`、`forms.mjs` | 拼接 HTML | React TSX 组件及受控表单 |
| `renderer/reader.mjs` | PDF.js 渲染、文本提取 | React 懒加载阅读器 + PDF.js worker |
| `preview.cjs` | Node 开发预览服务 | Vite；浏览器测试使用显式注入的测试适配器 |

Electron 数据目录为 `%APPDATA%/scientify-desktop-sample/workspace/`。格式为 schema 3，包括 teams、projects、papers、records、runs、tasks、sessions、subscriptions、trash、recent、activity、settings、navigation。附件以 UUID 为文件名存在 attachments 下。JSON 导出只含索引，不含二进制。当前项目未有 Git 提交，实施前须另外保存源代码快照，不能将 untracked 文件误当作可丢弃文件。

## 3. 技术选型（固定路线）

| 层 | 采用技术 | 约束 |
| --- | --- | --- |
| 桌面 | Tauri 2，Rust edition 2021 | 主窗口原生标题栏；single-instance 插件；NSIS 安装包 |
| UI | React 19、TypeScript strict、Vite 6 | createRoot；组件拥有 DOM；禁止拼接业务 HTML |
| 样式 | Tailwind CSS 4 + CSS 变量 | 保留米白、灰绿、紧凑侧栏的视觉语言；本地字体；可见焦点、减弱动效 |
| 状态 | Zustand 5 | workspace 单一状态源；操作提交后才更新已保存状态；瞬时筛选不写工作区 |
| 编辑与阅读（M2/M3） | CodeMirror 6、react-markdown、remark-gfm、PDF.js | 按功能动态导入；默认不解析任意 HTML；PDF worker 本地打包 |
| IPC | `@tauri-apps/api/core.invoke` | 一个领域操作一个 Rust command；禁止万能 method 执行器 |
| 数据 | serde/serde_json、atomicwrites、fs2 | schema 3 JSON 延续；保留未知字段；不在本轮改为 SQLite |
| 原生能力 | dialog 插件，后续按需增加 opener | 前端无通用文件系统或 shell 权限；读写路径由 Rust 确定 |
| 网络（M3/M4） | reqwest + rustls、tokio、quick-xml | HTTP 全在 Rust；限流、超时、取消、响应大小上限 |
| 子进程（M5） | tokio::process::Command | 参数数组、无 shell 字符串、超时与进程回收；保留 Git/XeLaTeX 外部依赖 |
| 测试 | Rust 单元/集成测试、Vitest、React Testing Library | 独立临时数据；保留原 Node 回归测试；原生运行与打包分别验收 |

依赖以 pnpm-lock.yaml 和 Cargo.lock 的实际解析版本锁定。pnpm 采用本机已安装的 10.11.0，Node 22.14.0；不为模仿参考仓库而额外升级全局工具。React/Vite 等主版本与参考项目对齐。

## 4. 工程结构

```text
Scientify/
  src/
    main.tsx
    app/App.tsx
    components/              # 原生 dialog 封装、通用反馈
    features/projects/      # 空间、项目表单、概览
    domain/workspace.ts     # schema 3 类型和前端纯操作
    stores/workspace.ts     # 加载、提交、错误/繁忙状态
    platform/desktop.ts    # 唯一 Tauri 调用入口
    styles.css
  crates/scientify-core/
    src/workspace.rs         # 无 Tauri 依赖的数据规范
    src/storage.rs           # 串行事务、备份、迁移
  src-tauri/
    src/lib.rs               # command 与应用生命周期
    src/main.rs
    capabilities/main.json
    tauri.conf.json
  Cargo.toml
  pnpm-lock.yaml
  electron/、renderer/、tests/ # 迁移期间保留的旧实现与回归基线
```

旧实现只用于迁移核对与回退，默认 start 改为 Tauri。M6 全量验收后才删除 Electron、旧渲染器、Node 服务和旧 lockfile。新构建产物不得引用上述目录。M1 期间新 UI 应明确提示尚未迁移的业务界面，不能用空操作按钮冒充完整功能。

## 5. 数据与事务

### 5.1 数据路径

生产路径固定为 Tauri `app_data_dir()/workspace`，identifier 为 `com.scientify.desktop`。Windows 对应 `%APPDATA%/com.scientify.desktop/workspace`。调试构建默认使用仓库 `.tauri-data/workspace`，避免开发操作触及生产数据。`SCIENTIFY_DATA_DIR` 仅在 debug 构建允许覆盖，以便自动验收。前端显示实际数据路径。

首次使用新应用时不自动写入旧目录。提供“迁移 Electron 数据”操作：Rust 从固定旧路径读取并验证 JSON，将整个旧 workspace（含 attachments、备份、previous-workspace.json 等）复制进同父目录 staging，拒绝符号链接/reparse 路径，校验完成后原子移动为新 workspace。仅允许迁入空的新工作区，不合并两个已存在的工作区。失败不得创建部分可用的新主文件；旧目录始终只读。迁移后两版应用的数据分别演进，回退不会自动带回新版本修改。

### 5.2 保存与恢复

- Rust 持有互斥锁和进程级文件锁；同一路径只能有一个写入者。
- 每次保存携带 `expectedRevision`，必须与磁盘 revision 一致，新的 revision 必须恰为旧值 + 1。过期提交明确报错，不能覆盖新内容。
- 前端在提交成功前保留已保存快照并禁止并发写操作；失败保留表单内容，显示错误且可重试。M2 自动保存引入串行队列与待保存快照，沿用同一冲突协议。
- 写入：验证 → 读取并验证旧主文件 → 原子写备份 → 原子替换主文件；每个临时文件 flush/sync。主文件损坏时拒绝普通保存，不能用空工作区覆盖。
- 恢复：验证 backup → 原样保存 unreadable 主文件 → 原子替换主文件；恢复失败保留原件。
- JSON 导入：完整校验 → 保存独立 before-import 快照 → 递增本地 revision → 原子替换。原生导入/导出对话框只返回业务结果，不给 WebView 任意路径读写权限。
- 最大 JSON 64 MiB；每个业务集合最多 50,000 条。ID 唯一、引用完整、文本/数值有效。无 teams 的旧 schema 3 自动归入 personal。未迁移业务数据、未知字段与附件索引必须原样保留。

### 5.3 M1 command 契约

| command | 输入 | 输出 |
| --- | --- | --- |
| `workspace_load` | 无 | workspace 或 null、directory、legacyAvailable |
| `workspace_save` | workspace、expectedRevision | 已验证且已落盘的 workspace |
| `workspace_restore` | 无 | 恢复后的 workspace |
| `workspace_migrate_legacy` | 无 | 完整复制后的 workspace |
| `workspace_import` | 无；Rust 打开 JSON 选择器 | workspace 或 null（取消） |
| `workspace_export` | 无；Rust 打开保存对话框 | saved 布尔值 |
| `choose_directory` | 无 | 目录字符串或 null |

错误通过 invoke reject 返回用户可读文本；不把失败包装成成功结果。所有命令仅供本地 main 窗口；不授予远程页面权限。

## 6. 安全与生命周期

CSP 只允许本地静态脚本、IPC 和必要样式；开发地址固定 127.0.0.1:1420、strictPort。配置显式 command 权限，禁用远程导航。用户文本由 React 转义。Rust 校验是权威边界，前端类型不能替代运行时校验。

M1 显式保存的原生表单有 dirty 关闭确认；提交过程中禁止退出。后续自动保存编辑器在 close-requested 中 await flush，失败留窗。用户确认放弃草稿后才销毁窗口。监听器清理考虑 React StrictMode。单实例插件负责唤醒已有窗口，文件锁负责同数据目录的第二写入者。

后续 Ollama 仅允许 localhost/127.0.0.1/::1，禁用跨主机重定向；arXiv 固定 HTTPS 域名，限制下载尺寸并检查 PDF 头。Git 路径来自已关联项目，`--literal-pathspecs`、`--` 分隔文件参数；提交保持 `commit --only` 语义。XeLaTeX 在独立导出目录中运行，保留 `-no-shell-escape`、超时及实际日志；不宣称其是完整文件系统沙箱。

## 7. 唯一实施顺序与验收门槛

### M1：桌面和持久化主链路（本次启动交付）

1. 保存原代码快照，建立 pnpm/Vite/TypeScript、Cargo workspace、Tauri 配置。
2. Rust 实现 schema 3 校验、JSON 原子保存、冲突保护、备份恢复、旧目录完整复制、JSON 导入导出。
3. React 实现个人/团队空间切换、创建/编辑团队、创建/编辑项目、目录关联、收藏、归档/恢复、空间转移、搜索、排序、网格/列表和项目概览；概览显示已有数据数量与待办。
4. 保留旧源码和旧测试，不挂接旧 DOM 渲染器，不使用 Node 后端。
5. 验收：前端 typecheck/build、新旧测试、cargo fmt/check/test/clippy；原生 debug 构建；使用临时目录验证数据持久化。记录无法执行的检查及原因，不能将浏览器 mock 测试等同于原生 IPC 验收。

### M2：研究工作台

迁移多标签、模板、Markdown 编辑预览、状态看板、记录创建/复制/移动、回收站和任务管理。自动保存需测试连续输入/跨标签切换/关闭时 flush、失败重试和不覆盖未保存草稿。保留旧记录类型与字段语义。

### M3：文献与订阅

Rust 附件导入读取/保存、SHA-256 去重、50 MiB 限额；React PDF 阅读、分页缩放、摘录、笔记、标签、阅读状态和项目归属；Rust arXiv 查询与全文下载。检验 PDF worker 离线打包、中文字体、30 页文本提取上限、重复导入和下载取消。

### M4：项目助手

Rust Ollama 模型检测、对话请求、requestId 取消注册表、超时回收；React 多会话、材料选择、重试、复制、保存为记录。先保持原有非流式行为，流式能力另行演进。禁止用预设内容伪造真实模型响应。

### M5：实验、Git 与导出

迁移实验表单、指标比较和附件；Rust Git status/diff/selected commit；TypeScript 内容安全转义生成 LaTeX，Rust XeLaTeX 编译和日志/产物管理。必测 0 与缺失指标区分、不同评价协议不标记最佳值、无关 staged 文件不进入提交、程序不存在/超时处理。

### M6：切换与清理

全模块真机回归、旧数据样本全量往返、恢复演练、关闭保护、安装卸载/升级、NSIS 构建与许可清单。完成后移除 Electron 依赖、旧脚本、旧渲染器、package-lock.json 和过渡启动方式。签名、自动更新与多平台发布另列发布工作，不复用 Oleafly 的密钥或发布服务器。

## 8. 验证、回退与交付约定

Rust 测试覆盖缺失字段、孤儿引用、重复 ID、未知字段保留、兼容旧团队格式、过期 revision、损坏主文件、备份恢复、非法导入不改变磁盘、整个附件目录迁移、迁移中断/非空目标/链接拒绝和单写入者。React 测试覆盖真实 store 与组件的提交失败、重试、搜索和空间隔离；测试后端只在测试注入，生产没有内存持久化降级。

旧版可从迁移前源码快照恢复，使用原目录数据；新项目默认通过 `pnpm start` 启动 Tauri。新项目中的 `pnpm legacy:start` 在 M1–M5 期间保留旧应用回归入口。新数据回退到旧版需在关闭应用后单独备份并复制完整工作区，不直接让两个应用并发使用同一目录。

每阶段结束在本目录的《迁移实施记录》中列出已完成能力、实际命令及结果、未迁移模块。M1 成功不等于产品功能说明已全部实现。

## 9. 官方依据

- Tauri 前端架构与 Vite SPA：[Frontend Configuration](https://v2.tauri.app/start/frontend/)。
- Tauri 配置、构建与安全配置：[Configuration](https://v2.tauri.app/reference/config/)。
- 单实例生命周期：[Single Instance](https://v2.tauri.app/plugin/single-instance/)。
- invoke 与 Rust 后端分层：[Tauri Architecture](https://v2.tauri.app/concept/architecture/)。

这些资料用于确认框架机制；Scientify 功能清单和数据格式以本机代码为准。
