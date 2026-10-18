# Scientify Logo 素材库

标志是一只打开的箱子和一颗从箱口升起的圆点。箱子是安放文献、代码和运行环境的科研沙箱，圆点是从中诞生的结果。所有文件由 source/build.mjs 从同一份几何定义生成，svg/ 为矢量母版。

## 选择素材

| 场景 | 文件 | 用法 |
|---|---|---|
| Windows 桌面 / 安装包 / 默认任务栏 | desktop/scientify.ico | 推荐默认：深色底板、白色箱体、荧光绿圆点 |
| 深色底板图标 | desktop/scientify-dark.ico、desktop/dark/scientify-{尺寸}.png | 与默认图标相同 |
| 浅色底板图标 | desktop/scientify-light.ico、desktop/light/scientify-{尺寸}.png | 浅色底板、墨黑单色标志 |
| 浅色 App 界面 | app/light/scientify-{尺寸}.png | 墨黑单色，透明背景 |
| 深色 App 界面 | app/dark/scientify-{尺寸}.png | 白色箱体配荧光绿圆点，透明背景 |
| 浅色任务栏 / 托盘 | taskbar/light/scientify-{尺寸}.png 或 taskbar/scientify-light.ico | 标志占比更大 |
| 深色任务栏 / 托盘 | taskbar/dark/scientify-{尺寸}.png 或 taskbar/scientify-dark.ico | 由应用按背景选用 |
| 网站标签页 | web/favicon.ico、web/favicon.svg | ICO 含 16 / 32 / 48 px |
| Web App / 收藏图标 | web/icon-180.png、icon-192.png、icon-512.png | 深色底板 |
| 矢量母版 | svg/scientify-{mark-light, mark-dark, mark-white, icon-dark, icon-light}.svg | 官网、印刷与再加工 |
| 高分辨率位图 | master/scientify-light-1024.png、scientify-dark-1024.png | 透明背景 |

light / dark 表示使用场景的背景主题，而非图案本身颜色。桌面默认图标不随系统主题改变；透明任务栏图标需要开发侧按实际背景切换。

## 尺寸与留白

App 与桌面 PNG：16、20、24、32、40、48、64、96、128、192、256、512、1024 px。
任务栏 PNG：16、20、24、32、40、48、64 px。
桌面和任务栏 ICO：每个内含 16、20、24、32、40、48、64、128、256 px，共 9 帧，最大帧在前。

透明标志高度约占画布 82%，任务栏约 90%。App 图标底板占画布 95%，标志高度约为底板的 64%。标志按视觉重心与外框居中各取一半定位，箱体居中，圆点不贴近上沿。32 px 及以下导出时，箱口、竖缝和圆点外圈的镂空加宽到至少约 0.9 px，缩小后仍能分辨。

不要拉伸、旋转、加阴影或描边，不要单独改动圆点的大小和位置。原生像素效果见 preview.html。

## 品牌颜色

墨黑 #111A17、荧光绿 #C6F24E、白 #FFFFFF；浅色底板 #F7F8F6，描边 #D3D9D6。
荧光绿只用在深色背景上。荧光绿在白底上对比度不足，浅色背景一律用墨黑单色版。

## 交付与接入

- 应用内标志 `public/brand/scientify-{light,dark}.png` 取自 app/{light,dark}/scientify-96.png，`public/favicon.ico` 取自 web/favicon.ico。
- 原生图标源帧 `src-tauri/icons/source/` 取自 desktop/scientify.ico 与 desktop/dark/scientify-{96,192}.png；其余平台图标由 desktop/dark/scientify-1024.png 生成，命令见 [public/brand/README.md](../../../public/brand/README.md)。
- preview.png / preview.html 为总览；manifest.json 为 PNG 清单；validation.json 记录尺寸、RGBA、ICO 帧顺序与标志居中检查结果。
- web/site.webmanifest 是图标配置示例，部署时合并到现有配置；图标为 purpose: any，并非 maskable 图标。

## 重新生成

在仓库根目录运行 `node "docs/营销思路/Scientify-Logo-Kit/source/build.mjs"`。需要已安装的依赖（Playwright）和本机 Chrome 或 Edge，可用 `SCIENTIFY_BROWSER_PATH` 指定其他 Chromium。生成后检查 validation.json 的 status，再按上文同步应用内文件。

source/ 下的 original-logo.png、master-transparent.png、generation-prompt.txt、build.cjs 属于旧版双半脑标志，已不再使用。不要运行 build.cjs，它会用旧图案覆盖本素材包。
