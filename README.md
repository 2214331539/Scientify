<p align="center">
  <img src="docs/营销思路/Scientify-Logo-Kit/web/icon-192.png" width="88" alt="Scientify logo" />
</p>

# Scientify

**一个入口，贯穿科研全过程。**

面向计算型研究者的本地科研工具。在同一个项目里阅读论文、记录思考、编辑和运行 Python 实验，并可配置地在本地使用AI辅助。

[English](README.en.md) · [快速开始](#快速开始) · [使用文档](docs/产品功能文档/桌面使用说明.md) · [参与贡献](CONTRIBUTING.md) · [路线图](ROADMAP.md) · [问题反馈](https://github.com/2214331539/Scientify/issues)

![Stage: Alpha](https://img.shields.io/badge/stage-alpha-orange)
![Desktop: Windows x64 and macOS arm64](https://img.shields.io/badge/desktop-Windows_x64_%7C_macOS_arm64-blue)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

> **当前是早期开发版本。** Windows x64 与 macOS Apple Silicon 安装包通过 [GitHub Releases](https://github.com/2214331539/Scientify/releases) 分发，标记为 Pre-release。Windows 尚未签名；Mac 为 ad-hoc 签名、未公证预览版。不提供 Intel Mac、Linux 或移动端安装包。

## 为什么做 Scientify

完成一个科研项目需要去Arxiv上搜论文，用本地PDF阅读器打开，用ChatGPT翻译和理解，再去Google Scholar搜论文。确定论文思路以后有不得不打开VScode跑实验代码，又要拿Git做版本管理，多个baseline还得开多个文件夹，忙到最后打开Overleaf开始写论文...

流程太繁琐了，工具太分散了，需要一个统一入口。

这个入口就是Scientify：

- **本地文件可以继续使用。** 文献是 PDF，单篇论文笔记是相邻的 Markdown 文件，代码保留在托管或自行关联的目录里。
- **每次实验都有记录。** 查看实际命令、环境、代码状态、日志和产物；手动运行无需模型密钥。
- **AI 按需接入。** 使用自己的模型服务；Agent 会话绑定具体项目与目录，执行过程提供审批和中止入口。
- **界面围绕当前任务。** 阅读、编辑、实验和笔记共享工作区，辅助面板按需打开。

## 当前可以做什么

| 工作         | 当前能力                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------- |
| 管理课题     | 项目书架、搜索、收藏、归档、目录关联，个人与本机团队分类                                           |
| 阅读文献     | 本地 PDF 目录树、搜索、分页或连续阅读、选文摘录、与 PDF 配对的 Markdown 笔记                       |
| 浏览网页     | Windows / macOS 原生网页标签、地址与关键词输入、前进后退、下载到文献目录                                   |
| 整理研究笔记 | 项目笔记、快速笔记、自动保存与来源返回                                                             |
| 开展实验     | 代码编辑、Python 解释器与 venv/已有 Conda 管理、交互终端、本地运行、日志、停止、产物及基础指标比较 |
| 管理代码版本 | Git diff、暂存、提交、本地分支、历史、stash 和 worktree                                            |
| 撰写草稿     | Markdown 预览，以及 LaTeX、BibTeX 等文本文件编辑                                                   |
| 使用 AI      | 多种模型协议、流式对话、本地 Agent、会话恢复、审批及关联实验运行                                   |

建议从一个小任务开始：**创建项目 → 关联文献与代码目录 → 阅读并记笔记 → 运行 Python 脚本 → 查看日志与结果。**

## 快速开始

### 下载安装

在 [Releases](https://github.com/2214331539/Scientify/releases) 打开最新的预发布版本，按设备选择安装包。普通使用无需安装 Node.js 或 Rust。

| 平台 | 文件 | 安装方式 |
| --- | --- | --- |
| Windows 10 / 11 x64 | `Scientify_<版本>_windows_x64_setup.exe` | 运行安装器 |
| macOS 14+ Apple Silicon（M 系列） | `Scientify_<版本>_macos_arm64.dmg` | 打开 DMG，将 Scientify 拖入 Applications |

Mac 首次打开可能被系统阻止。确认下载来源后，在系统设置 → 隐私与安全性中使用“仍要打开”；无需关闭 Gatekeeper。可用 `shasum -a 256 <安装包>` 对照发布页校验值。

- 适用于 Windows 10 / 11 x64；缺少 WebView2 时安装器需要联网安装运行时。
- Python 与 Git 按需自行安装。阅读论文与笔记无需模型密钥；AI 使用自己的模型服务配置。
- 当前安装包未签名，Windows 可能显示“未知发布者”。发布页附 `SHA256SUMS.txt`，可使用 `Get-FileHash <安装包路径> -Algorithm SHA256` 核对完整性。
- 更新前关闭应用并备份 `ScientifyData` 和关联的外部目录，再运行新安装包。第一版暂不提供自动更新。

### 从源码运行桌面版

共同依赖为 [Node.js 24 LTS](https://nodejs.org/)、pnpm 10.11.0、Rust stable。Windows x64 还需 [MSVC C++ Build Tools 和 WebView2](https://v2.tauri.app/start/prerequisites/#windows)；Apple Silicon Mac 需要 macOS 14+ 与 [Xcode Command Line Tools](https://v2.tauri.app/start/prerequisites/#macos)（`xcode-select --install`）。使用原生 arm64 的 Node / Rust，不通过 Rosetta 构建。

```powershell
git clone https://github.com/2214331539/Scientify.git
cd Scientify
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm start
```

首次启动会准备 PDF 资源并从 GitHub 下载固定版本的 Agent 引擎，需要网络。Python 和 Git 按对应功能自行安装；阅读与笔记无需配置模型。

### 构建本机可执行程序

```powershell
pnpm tauri build --no-bundle
```

Windows 构建后运行 `Scientify-MVP.cmd`。该脚本从仓库构建目录选择最新程序，本身不是安装包。Windows NSIS 打包命令为 `node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis -- --locked`，产物位于 `target/release/bundle/nsis/`。自动发布和分支约定见[版本发布说明](docs/技术方案/版本发布与分支管理.md)，签名与自动更新仍在[路线图](ROADMAP.md)中。

Mac 打包命令为 `node node_modules/@tauri-apps/cli/tauri.js build --bundles app,dmg -- --locked`，产物位于 `target/release/bundle/dmg/`。本机无证书时使用 ad-hoc 签名。

`pnpm dev` 用于前端浏览器预览，使用独立数据。它不具备桌面文件访问、真实终端、实验执行和内嵌浏览器能力，不能当作完整 Web 版。

## 数据与 AI

- PDF、相邻论文笔记和代码保留在本地目录。应用元数据、项目研究笔记和运行记录由本地数据目录管理。
- Windows 正式构建默认在可写安装目录附近使用 `ScientifyData/`；Mac 默认使用 `~/Library/Application Support/com.scientify.desktop/ScientifyData/`。设置中可以安排数据迁移。开发构建使用独立的 `.tauri-data/`。
- **JSON 导出不包含 PDF 和源码。** 完整备份需要复制应用数据和外部关联目录；详细步骤见[数据说明](docs/产品功能文档/桌面使用说明.md#数据与文件)。
- 使用远程模型时，选定材料或 Agent 读取的内容可能发送给所配置的服务商，费用遵循该服务商规则。本地优先不等于所有功能离线运行。
- 当前模型密钥保存在本机未加密的凭据文件中。不要分享整个数据目录、浏览器资料或带密钥的日志；该限制与报告方式见[安全说明](SECURITY.md)。
- 手动终端和手动实验使用用户授予信任后的本机权限；AI 正式运行使用工作区沙箱。两者的权限范围不同。

## 当前边界

- 团队空间是本机分类，尚无账号登录、多人同步或在线权限管理。
- 订阅推荐和个人信息源尚未启用；没有 PDF OCR、批注系统或全文语料库。
- 暂无 Notebook 单元执行、断点调试、远程 GPU 调度，以及完整 Git 远程与冲突解决界面。
- LaTeX 可以编辑，尚未集成编译。记录运行条件不等于完整冻结所有依赖或保证可复现。
- 文件草稿不保证崩溃恢复；终端进程不会在应用重启后恢复。
- Mac 预览版使用 WKWebView；网站兼容性、最低系统版本与完整人工科研流程仍需实机反馈。Intel、Linux 暂不支持，见[跨平台实现与验证范围](docs/技术方案/跨平台适配路线.md)。

## 参与开发

欢迎代码、文档、翻译、复现报告和科研示例。请先阅读[贡献指南](CONTRIBUTING.md)与[社区行为规范](CODE_OF_CONDUCT.md)。小修复可以直接提交 PR；新功能、依赖、数据结构或权限改动先通过 Issue 讨论范围。

技术栈为 **Tauri 2 + Rust、React 19 + TypeScript、Vite、Zustand、CodeMirror 和 PDF.js**。界面、原生能力及存储边界见[架构入口](docs/架构设计/技术方案.md#0-当前基线与-uiux-固定准则)。

```text
src/                     React 工作区、编辑器、PDF 阅读器与类型化 IPC
src-tauri/               桌面窗口、文件、进程、浏览器与 Agent 集成
crates/scientify-core/   本地存储、校验与文件事务
scripts/                 资源准备和验收工具
docs/                    产品、架构、UI/UX 与开发记录
```

运行检查前先执行 `pnpm run build`，准备被 Git 忽略的资源和协议绑定。

```powershell
pnpm check
pnpm test --maxWorkers=2
cargo fmt --all --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

当前 [Windows CI](.github/workflows/ci.yml) 与 [Apple Silicon CI](.github/workflows/macos.yml) 执行各自构建与回归检查；Mac CI 还验证受控原生浏览器和 DMG。CI 通过不代替完整人工验收。文档修改只需检查事实与链接。协作决策与维护职责见[治理规则](GOVERNANCE.md)。

## 文档与许可

- [桌面使用说明](docs/产品功能文档/桌面使用说明.md)：文件、模型、存储、备份与操作细节。
- [文档索引](docs/README.md)：产品规格、架构、UI/UX 与开发记录；设计目标不等于已交付功能。
- [路线图](ROADMAP.md)：当前重点和接受贡献的方向。
- [安全说明](SECURITY.md)：已知边界及私密报告方式。

Scientify 原创代码与文档采用 [Apache License 2.0](LICENSE)。贡献者保留各自版权；第三方组件遵循其原始许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。许可证不授予 Scientify 名称或标识的商标使用权，也不代表对衍生发行版的官方背书。

感谢 Tauri、React、CodeMirror、PDF.js、xterm.js、OpenAI Codex 和其他依赖的维护者。Scientify 是独立项目，与这些项目及其维护组织无官方隶属关系。
