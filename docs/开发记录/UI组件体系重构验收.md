# UI 组件体系重构验收

日期：2026-09-24

## 本轮交付

| 层次 | 实现 |
| --- | --- |
| 基础控件 | Button / IconButton、Input / Textarea、Dropdown、Tooltip、状态 Badge |
| 布局 | AppShell、Sidebar、Panel；保留六入口 Rail 与按需辅助栏 |
| 工作区 | Section、ResourceList / ResourceRow、ActivityList、TreeView、WorkspaceFrame |
| 首页 | 项目信息、真实最后更新时间、继续工作列表、活动时间线、待办 |
| AI | Context 与 Actions；当前项目 / 文件 / 选区，动作仅准备问题并聚焦输入 |
| 页面迁移 | 项目、文献、订阅、笔记、实验、论文与文件、搜索、设置、PDF 工具栏 |

业务存储、文件会话、模型请求及草稿保护沿用。未增加实验执行、编译或模型服务能力，未引入新 UI 依赖。本轮没有使用设计 Skill。

代码组织与约束见 [Workspace UI](../../src/components/README.md)。当前项目 `src` 中的原生 button/input/select/textarea 定义仅位于 primitives，页面通过共享组件创建控件；第三方编辑器内部 DOM 不计入该静态检查。

## 验证

- 类型检查、格式检查通过。
- 全量前端测试：15 个文件、58 项通过；最终区域语义与列表标题调整后，相关 5 文件 19 项再次通过。
- 新增交互覆盖：禁用按钮提示、焦点与 Escape、激活时关闭提示、原生表单和 ref、浮层视口边界、文件树键盘导航、AI 不自动发送及不覆盖草稿。
- 浏览器实际检查：项目管理、首页活动排列、文献列表、论文编辑、笔记列表、上下文动作与焦点、浅色 / 深色、窄窗口顶栏图标。检查结束无控制台错误，恢复原主题偏好。
- 修正 CSS 层叠顺序，确认主要按钮文字和背景对比度、工作区列表排列均正确。
- Vite 生产构建与 Tauri release 构建通过。可执行文件生成时间：2026-09-24 10:43。

构建保留现有的前端大分块体积提示；本轮未进行打包体积优化。桌面程序已构建，未关闭用户正在运行的旧窗口，也未对新桌面进程执行原生端到端复测。

## 使用

关闭旧 Scientify 窗口，运行 `F:\Project\Scientify\Scientify\Scientify-MVP.cmd`。

脚本优先启动 `target/ui-shell/release/scientify.exe`。新旧 release 沿用同一数据目录，无需迁移。
