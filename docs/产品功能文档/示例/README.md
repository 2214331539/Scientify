# 实验代码页面示例

[打开离线 HTML](../实验代码页面示例.html)，直接用浏览器打开。该原型服务于 [实验代码管理详细产品设计](../实验代码管理详细产品设计.md) 的布局评审，不修改实际应用。

## 页面截图

- [Code 编辑与日志](实验代码-Code.png)
- [Runs 运行列表与详情](实验代码-Runs.png)
- [运行比较](实验代码-Compare.png)
- [Changes 双栏差异](实验代码-Changes.png)
- [1000px 窗口](实验代码-1000.png)
- [390px 窄屏](实验代码-Mobile.png)
- [深色外观](实验代码-Dark.png)

## 演示边界

示例使用虚构项目和预设指标。代码编辑、标签切换、配置修改、手动记录、结果比较、模拟运行及停止可交互；所有修改仅保留于当前页面内存，刷新重置。没有真实命令执行、磁盘写入、环境检测、Git 操作或模型连接。Git 差异展示预设文件，不代表完整版本管理能力。

参考 VS Code 的文件树、编辑标签和底部面板组织方式，以及 Git 的版本差异检查方式；实验配置、运行记录和比较独立于 AI 对话。导航保留五个产品入口，不提供 Files 页面。

## 构建与验证

在仓库根目录执行（依赖项目已有 node_modules）：

```powershell
node docs/产品功能文档/示例/build-experiment-prototype.mjs
```

模板、交互源码与构建脚本在本目录。输出 HTML 内嵌编辑器、图标与样式，不依赖在线 CDN。不要手工修改生成 HTML。

验证脚本使用 Windows Edge 和安装在临时目录的 Playwright，不更改项目依赖：

```powershell
npm install --prefix "$env:TEMP/scientify-prototype-tools" --no-audit --no-fund playwright
node docs/产品功能文档/示例/verify-experiment-prototype.mjs
```

脚本检查草稿保留、配置、环境弹窗、独立任务、手动记录来源、产物归属、比较、差异、文件搜索、可选 AI、主题和响应式布局，并生成截图与 [验证记录](验证记录.json)。这些是浏览器交互与布局检查，不是桌面程序回归或人工视觉验收。
