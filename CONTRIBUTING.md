# Contributing to Scientify

欢迎贡献代码、文档、翻译、可复现的 Bug 报告与可公开分发的科研示例。中文和英文 Issue / PR 均可。参与前请阅读[行为规范](CODE_OF_CONDUCT.md)。

Contributions in Chinese or English are welcome. Small fixes can go directly to a pull request. Discuss new features, dependencies, data formats, and permission changes in an issue first. Contributions are distributed under the project's Apache-2.0 license; contributors retain their copyright. No CLA or copyright assignment is required.

## 选择一个任务

先搜索 [Issues](https://github.com/2214331539/Scientify/issues)，避免重复报告。提交新需求时描述实际任务、当前障碍和期望结果。小修复可直接发 PR；新页面、架构、数据迁移或权限变更先讨论范围，避免完成大量工作后无法合入。

适合首次贡献的工作包括：改进文档、补充翻译、修复已复现的焦点与键盘问题、完善错误提示，以及补充有意义的回归验证。任务未被认领时，可以说明准备采取的方案，不需要等待分配权限。

## 准备开发环境

目前桌面开发以 Windows x64 为基线。安装 Node.js 24 LTS、pnpm 10.11.0、Rust stable、MSVC C++ Build Tools、WebView2，以及测试需要的 Git 和 Python 3。

Fork 仓库，克隆自己的 fork，再添加上游：

```powershell
git clone https://github.com/YOUR-USERNAME/Scientify.git
cd Scientify
git remote add upstream https://github.com/2214331539/Scientify.git
git switch -c fix/describe-the-change
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm start
```

`YOUR-USERNAME` 替换为你的 GitHub 用户名。默认分支与 PR 目标统一为 `main`。开始任务前先同步上游 `main`，再创建短期分支。

## 分支与合并

采用 GitHub Flow：`main` 保持可构建、可发布；每个任务独立分支，通过 PR 合入，不设置长期 `develop`。

| 分支 | 用途 | 示例 |
| --- | --- | --- |
| `main` | 唯一长期主分支 | 从这里创建发行标签 |
| `feat/<topic>` | 新功能 | `feat/paper-search` |
| `fix/<topic>` | 修复与热修复 | `fix/pdf-note-rename` |
| `docs/<topic>` | 文档 | `docs/getting-started` |
| `chore/<topic>` | 构建、依赖与维护 | `chore/release-0.3.0` |
| `refactor/<topic>`、`test/<topic>` | 重构与验证 | `test/workspace-save` |
| `codex/<topic>` | 自动化助手创建的任务分支 | `codex/windows-alpha-release` |

分支名使用小写英文和连字符，可加入 Issue 编号。提交与 PR 标题使用 `feat:`、`fix:`、`docs:`、`chore:`、`refactor:` 或 `test:` 前缀。破坏兼容性的改动需显式说明。

合并前必须通过 `Windows checks / windows` 并解决讨论。维护者使用 squash merge，合并后删除任务分支；不直接在 `main` 开发，不强推或删除 `main`。当前单维护者阶段不要求另一位维护者审批，以免阻塞自身 PR；外部贡献仍由维护者审阅。GitHub 服务端保护是否可强制执行取决于仓库可见性和套餐，不能用书面约定代替实际保护。

发布流程与故障处理见[版本发布说明](docs/技术方案/版本发布与分支管理.md)。

首次启动或构建会下载固定版本的 Agent 引擎并生成协议类型。请使用 `pnpm run build` 准备资源后再运行检查；仅执行 `pnpm install` 不会生成这些文件。`pnpm dev` 是隔离的前端预览，仍会执行资源准备脚本，不能验证原生能力。

开发构建使用 `.tauri-data/`。测试必须使用临时目录或夹具，不能拿真实研究项目、模型密钥或浏览器资料作测试数据。

## 代码边界

- 先读 [AGENTS.md](AGENTS.md)、[文档索引](docs/README.md)和相关目录内的说明。
- React 组件通过 `src/platform/` 的类型化接口调用本机能力，不直接访问磁盘或进程。
- 原生权限与 IPC 变更同时检查 Rust 命令、`build.rs`、capabilities 和调用端。
- 文件保存、PDF 与笔记配对、冲突检查、运行身份及进程终止属于数据保护契约，不得绕过。
- UI 复用现有 primitives、语义变量与 [UI/UX 规范](docs/UI-UX/README.md)。主题或页面切换不能清空草稿、会话或运行状态。
- 错误、未实现功能和权限拒绝必须如实显示；不得用模拟成功、假数据或静默降级替代真实行为。
- 新依赖需要说明用途、许可、平台影响和体积。保留上游版权；不得提交无权再分发的论文、数据集或代码。

## 验证改动

在准备好资源的 checkout 中运行：

```powershell
pnpm check
pnpm test --maxWorkers=2
cargo fmt --all --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
git diff --check
```

前端格式遵循 Prettier；可以对修改的文件运行 `pnpm exec prettier --write <files>`。不要为小修复重排无关文件。

根据改动选择验证：文档只检查事实和链接；行为变更补能发现回归的测试；原生文件、进程、浏览器及窗口行为还需桌面验证。测试记录说明真实调用和夹具的区别。没有验证的平台或场景应在 PR 中明确标注。

CI 会运行 Windows 构建与回归检查。远程模型的真实效果、安装升级、长任务、窗口交互及数据恢复不能仅靠 CI 声称通过。

## 提交 Pull Request

1. 一个 PR 解决一个连贯问题，保持修改范围易于审阅。
2. 标题说明结果，例如 `fix: preserve paper notes when renaming a PDF`。
3. 描述触发条件、改后的行为、验证方式及数据兼容性；UI 改动附脱敏截图。
4. 更新受影响的使用说明与功能边界，不把设计目标标成已完成。
5. 接受审阅后补充修改。维护者负责最终合入，贡献量不自动获得发布权限。

禁止提交模型密钥、访问令牌、个人数据、应用运行目录、依赖目录和编译产物。AI 辅助贡献与其他贡献遵循同样规则：提交者需要理解、验证修改并确认来源许可，不要求上传私人提示词或对话记录。

## 许可与贡献归属

提交贡献表示你有权提供这些内容，并同意其按本仓库 [Apache-2.0](LICENSE) 条款分发；明确标注的第三方内容继续遵循其原始许可。贡献者保留版权，不要求版权转让或额外 CLA。复制或改编第三方内容时，需要注明来源、版本、许可证与修改情况。

项目决策见[治理规则](GOVERNANCE.md)，敏感问题见[安全报告](SECURITY.md)。
