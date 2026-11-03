# Scientify 开发入口

- 源码和文档根目录均为本仓库。先查 [项目说明](README.md) 与 [文档索引](docs/README.md)。
- 开发、验收和推送按 [开发与验收流程](docs/开发流程/开发与验收流程.md)：只用 `main`，推到 Tsingyu-x-THU/Scientify-Desktop；开工前先 `git pull`；每次更新在 [更新记录](docs/更新记录/README.md) 写范围、验收清单和自动检查结果。
- 开发版的数据在源码目录旁边的 `ScientifyDevData`，正式版的数据由 `scientify-storage.json` 指定。不要为了运行程序新建工作树，不要在源码目录运行 `git clean -x`，不拿正式数据做测试。
- 产品功能、页面结构和每页内容以 [产品设计](docs/产品设计/README.md) 为准；做功能前先读对应的页面设计，上线后更新其中的“现状”。
- UI/UX 工作先读 [标准入口](docs/UI-UX/README.md)，按任务阅读视觉、组件、动效、验收规范。现有组件说明在 [src/components/README.md](src/components/README.md)。
- 技术架构以 [总体架构第 0 节](docs/技术方案/总体架构.md#0-当前基线与-uiux-固定准则) 区分当前实现与后续目标。旧四入口、单窗口、Electron 方案不作为回退当前产品的依据。
- 复用现有 primitives、workspace 组件和语义变量。视觉变化不重置编辑会话、草稿、选区或保存保护；用户数据不作为演示夹具。
- 修改什么就验证什么。行为改动补有意义的回归验证；文档修改检查链接与事实，不要求重建桌面程序。不要自动关闭用户正在运行的应用。
- 文档使用仓库内相对链接；新增文件优先放入现有模块，不为规划预建空运行库。
