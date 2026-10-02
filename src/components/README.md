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
  navigation/         五个一级入口与二级视图配置
  primitives/
    Button.tsx        primary / secondary / ghost，含 IconButton
    Input.tsx         Input / Textarea
    Dropdown.tsx      保留原生键盘行为的 select；CSS picker 渐进增强
    Menu.tsx          右键/按钮菜单：定位、方向键、退出保留与焦点恢复
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
    ContextPanel.tsx  按需在弹窗查看当前项目、文件、选区及可用意图
    AssistantComposer.tsx 简洁输入、材料入口、模型胶囊与发送
    ChatMessageView.tsx 统一 Markdown 消息；用户靠右、助手靠左，悬浮复制反馈
```

## 组合规则

- 页面控制业务状态，布局和 primitive 不读写 store、磁盘或模型服务。
- 桌面只保留主 Topbar；空白区域通过 Tauri 拖动属性操作窗口，关闭按钮发起 close 请求，由 App 的未保存保护决定是否退出。浏览器不显示窗口控制。
- 项目管理只显示空间侧栏，其底部工具只保留设置与亮暗按钮；进入项目后显示 48px 五入口纯图标 Rail（Overview、Literature、Notes、Experiments、Paper）。名称放入 Tooltip 和 aria-label，不显示固定文字。
- Files 入口及独立 All files 页面直接移除，不作为隐藏页面保留。`src/workspaces/files/` 是实验 Code 与论文 Manuscript 复用的文件编辑模块，不能据此新增独立文件入口；文件会话、草稿与保存保护继续沿用。
- Panel 是无外阴影、无圆角外框的连续工作区域；Section 分组内容；List 表达对象集合；Tree 表达层级关系。表格保留其列语义。
- Button 接收原生属性与 ref。主要提交用 `primary`，普通操作用 `secondary`，工具栏与导航用 `ghost`。表单内明确指定 `type="submit"` 或 `type="button"`。
- 图标按钮使用 `iconOnly` 并提供 `aria-label`；`tooltip` 可补充快捷键或不可用原因。提示同时支持悬停、键盘焦点和 Escape，不使用额外布局包装。
- Input、Textarea、Dropdown 保留原生输入、选中和表单语义。普通页面不直接创建原生控件；编辑器和渲染内容中的第三方内部 DOM 不属于此约束。
- ResourceRow 生成 `li > button`，应放在 ResourceList 内。不要再套另一个按钮或交互元素；复杂多操作行使用列表项内并列操作。
- TreeView 接收 `items`、`selectedId`、`collapsed` 和操作回调。方向键与 Home/End 只移动焦点或展开层级；点击/Enter 才打开文件。
- 文献区直接组合 Sidebar、TreeView、DocumentTabs 和呈现层，不渲染 WorkspaceFrame 标题栏。文献库/订阅只切换边栏；DocumentTabs 不管理资源数据，关闭标签不删除文献。
- Badge 只表示 Draft、Running、Completed 等真实状态；数量、研究领域、文件类型使用普通文字。
- AI Actions 只准备输入；不自动请求、不覆盖已有输入。原有上下文隔离和草稿保护继续由功能层管理。
- AI 侧栏使用会话标题栏、消息区与底部 Composer。配置、历史和材料查看复用 Menu / Modal，不占用常驻聊天空间；模型胶囊列出同一服务最近获取的模型列表（旧配置兼容最近使用记录）。Enter 发送、Shift+Enter 换行，输入法组词阶段不触发发送。
- 消息复用 ChatMessageView，使用相同正文样式与左右对齐，不显示角色、材料标签或转笔记按钮。复制按钮在正文下方预留的位置淡入，支持悬停、键盘焦点及触屏；复制原始 Markdown，不包含隐藏上下文。成功短暂显示勾号，失败保留重试提示。
- 模型 Menu 使用 `anchor.placement='top'`，`y` 表示菜单底边，距胶囊上沿 6px；长列表在最多 360px、且不超过上方可用空间的菜单中滚动。其他菜单保留原定位，选中/关闭后恢复触发按钮焦点。
- GlobalDock 共用一个固定 AI/笔记顶栏，以同一网格内的保留内容层淡化切换；退出层立即 inert。移动笔记到中央区不改变编辑器实例，项目切换继续隔离各自草稿。
- 设置使用 `Modal` 的可选 `sidebar` / `heading` / `className` 槽位：固定分类栏与内容区，语言切换不重建 Modal。普通弹窗仍使用原接口；关闭保护共用。
- 模型配置由 `features/assistant/ModelSettingsDialog` 复用全局设置的 `settings-dialog` / `settings-navigation` / `settings-scroll`。左侧只放「模型配置」功能页入口；右侧以 Dropdown 选择服务商，编辑连接、测试连接并从返回列表选择模型；底部保存会先验证聊天权限。服务商预设独立于协议，列表请求和验证结果在地址/密钥变化时失效，不能回写过期结果；底部操作区固定。聊天草稿和配置保存仍由 AssistantPanel 管理，不再使用旧的内嵌侧栏表单样式。

## 样式归属

`styles/tokens.css` 是颜色、字体家族、控件尺寸、圆角及阴影的来源。基础控件和 Panel 放入 CSS `components` 层；工作区与页面样式负责内容排列，避免依赖 CSS 导入顺序。

外观使用白色与两级浅灰、细边界、4 px 控件圆角、8 px 浮层/对话框圆角，26 / 30 px 控件高度。阴影只用于浮层；背景与文字间距承担页面层级。

页面 CSS 只补充布局、宽度、密度、编辑内容和真实业务状态，不重定义整套 button/input/select 视觉规则。新增共享表现先扩展 primitive 或 workspace 组件，再迁移使用处。

## 变更检查

1. 检查项目切换、当前资源、草稿与未保存保护是否保持。
2. 检查图标提示、键盘焦点、禁用原因、空态与错误状态。
3. 在中央编辑器与右侧面板同时打开时检查宽度、滚动与工具栏。
4. 运行类型检查、相关行为测试及生产构建；交互变化才新增行为测试。

共享动效使用 `styles/motion.css` 与 token。项目和文献菜单统一用 Menu；业务确认/文本输入调用 `prompts.tsx`，脏表单交由 Modal 确认。新页面不使用 window.confirm / prompt。
