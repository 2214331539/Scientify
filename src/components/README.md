# Workspace UI

统一开发标准见 [docs/UI-UX](../../docs/UI-UX/README.md)，其中组件契约、交互动效与验收规则是后续实现的依据。本文用于快速定位已有代码；新规范中的待实现能力不能视为现有 API。

Scientify 通过导航、资源列表、面板与编辑器组织研究任务。页面组合这些组件，不创建功能卡片或独立的控件皮肤。

## 目录与职责

```text
components/
  layout/
    AppShell.tsx       顶栏、导航、中央区、辅助区和状态栏的布局槽位
    Sidebar.tsx        导航或资源区域的语义容器
    Panel.tsx          工作区域；可组合 header / toolbar / footer
    TopBar.tsx         项目切换和全局操作
    StatusBarTools.tsx 底栏右下角的 AI/笔记图标入口，保留开关状态与焦点返回标识
    WindowControls.tsx 原生窗口最小化、最大化/还原与受保护的关闭请求
  navigation/         六个一级入口与二级视图配置
  primitives/
    Button.tsx        primary / secondary / ghost，含 IconButton
    Input.tsx         Input / Textarea
    Dropdown.tsx      保留原生键盘行为的 select
    Tooltip.tsx       不增加布局包装的提示浮层
    Badge.tsx         仅表示资源或任务状态
  workspace/
    WorkspaceFrame.tsx 二级视图、资源区与中央呈现
    Section.tsx       标题、操作、内容的平面分组
    ResourceList.tsx  对象集合与 ResourceRow
    ActivityList.tsx  按日期与动作呈现研究活动
    TreeView.tsx      层级资源、展开状态、键盘导航
    DocumentTabs.tsx 文献标签栏，受控选择/关闭/新增及键盘导航
  ai/
    ContextPanel.tsx  当前项目、文件、选区及可用意图
    AssistantComposer.tsx 输入、模型入口与明确发送
```

## 组合规则

- 页面控制业务状态，布局和 primitive 不读写 store、磁盘或模型服务。
- 桌面只保留主 Topbar；空白区域通过 Tauri 拖动属性操作窗口，关闭按钮发起 close 请求，由 App 的未保存保护决定是否退出。浏览器不显示窗口控制。
- 项目管理只显示空间侧栏，其底部保留设置与数据入口；进入项目后显示 48px 六入口纯图标 Rail。名称放入 Tooltip 和 aria-label，不显示固定文字。
- Panel 是无外阴影、无圆角外框的连续工作区域；Section 分组内容；List 表达对象集合；Tree 表达层级关系。表格保留其列语义。
- Button 接收原生属性与 ref。主要提交用 `primary`，普通操作用 `secondary`，工具栏与导航用 `ghost`。表单内明确指定 `type="submit"` 或 `type="button"`。
- 图标按钮使用 `iconOnly` 并提供 `aria-label`；`tooltip` 可补充快捷键或不可用原因。提示同时支持悬停、键盘焦点和 Escape，不使用额外布局包装。
- Input、Textarea、Dropdown 保留原生输入、选中和表单语义。普通页面不直接创建原生控件；编辑器和渲染内容中的第三方内部 DOM 不属于此约束。
- ResourceRow 生成 `li > button`，应放在 ResourceList 内。不要再套另一个按钮或交互元素；复杂多操作行使用列表项内并列操作。
- TreeView 接收 `items`、`selectedId`、`collapsed` 和操作回调。方向键与 Home/End 只移动焦点或展开层级；点击/Enter 才打开文件。
- 文献区直接组合 Sidebar、TreeView、DocumentTabs 和呈现层，不渲染 WorkspaceFrame 标题栏。文献库/订阅只切换边栏；DocumentTabs 不管理资源数据，关闭标签不删除文献。
- Badge 只表示 Draft、Running、Completed 等真实状态；数量、研究领域、文件类型使用普通文字。
- AI Actions 只准备输入；不自动请求、不覆盖已有输入。原有上下文隔离和草稿保护继续由功能层管理。
- 设置使用 `Modal` 的可选 `sidebar` / `heading` / `className` 槽位：固定分类栏与内容区，语言切换不重建 Modal。普通弹窗仍使用原接口；关闭保护共用。

## 样式归属

`styles/tokens.css` 是颜色、字体家族、控件尺寸、圆角及阴影的来源。基础控件和 Panel 放入 CSS `components` 层；工作区与页面样式负责内容排列，避免依赖 CSS 导入顺序。

外观使用白色与两级浅灰、细边界、4 px 控件圆角、6 px 对话框圆角，26 / 30 px 控件高度。阴影只用于浮层；背景与文字间距承担页面层级。

页面 CSS 只补充布局、宽度、密度、编辑内容和真实业务状态，不重定义整套 button/input/select 视觉规则。新增共享表现先扩展 primitive 或 workspace 组件，再迁移使用处。

## 变更检查

1. 检查项目切换、当前资源、草稿与未保存保护是否保持。
2. 检查图标提示、键盘焦点、禁用原因、空态与错误状态。
3. 在中央编辑器与右侧面板同时打开时检查宽度、滚动与工具栏。
4. 运行类型检查、相关行为测试及生产构建；交互变化才新增行为测试。
