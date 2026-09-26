# Scientify Logo 素材库

以提供的 logo.png 为设计依据，保留双半脑与中央 S 形留白。原始文件存档于 source/original-logo.png；透明母版由内置 ImageGen 清理生成，存在轻微轮廓重绘，并非原图逐像素抠图。所有派生尺寸共用同一透明母版，保持系列一致。

## 选择素材

| 场景 | 文件 | 用法 |
|---|---|---|
| Windows 桌面 / 安装包 / 默认任务栏 | desktop/scientify.ico | 推荐默认，浅色圆角底板在不同背景下保持识别 |
| 深色桌面外观 | desktop/scientify-dark.ico | 深色底板与白色标识 |
| 浅色 App 界面 | app/light/scientify-{尺寸}.png | 深色图案，透明背景 |
| 深色 App 界面 | app/dark/scientify-{尺寸}.png | 白色图案，透明背景 |
| 浅色任务栏 / 托盘 | taskbar/light/scientify-{尺寸}.png 或 taskbar/scientify-light.ico | 标识占比更大 |
| 深色任务栏 / 托盘 | taskbar/dark/scientify-{尺寸}.png 或 taskbar/scientify-dark.ico | 白色图案；由应用按背景选用 |
| 网站标签页 | web/favicon.ico | 16 / 32 / 48 px 多尺寸 |
| Web App / 收藏图标 | web/icon-180.png、icon-192.png、icon-512.png | 带底板 |
| 高分辨率品牌素材 | master/scientify-light-1024.png、scientify-dark-1024.png | 透明背景 |

light / dark 表示使用场景的背景主题，而非图案本身颜色。桌面默认图标不需要随系统主题改变；透明任务栏图标需要开发侧按实际背景切换，文件本身不会自动适配主题。

## 尺寸与留白

App 与桌面 PNG：16、20、24、32、40、48、64、96、128、192、256、512、1024 px。
任务栏 PNG：16、20、24、32、40、48、64 px。
桌面和任务栏 ICO：每个内含 16、20、24、32、40、48、64、128、256 px，共 9 帧。

App 标识宽度约占画布 80%；任务栏在 16–24 px 时约占 90%，其他尺寸约占 86%；桌面图标使用 67% 标识宽度与圆角底板。这些设置用于让缩小后的标识保持可辨。轮廓未做单独像素手工修整。

界面显示 24 CSS px 时，可使用 48 px 文件满足 2 倍像素密度。不要拉伸长宽比、增加阴影或把黑色版本放在深色背景上。原生像素大小请在 preview.html 中查看。

## 品牌颜色

浅色界面图案 #111111；深色界面图案 #FFFFFF。
桌面浅色底板 #F7F8FA，描边 #CDD1D8。
桌面深色底板 #20242C，描边 #727985。

## 交付与接入

preview.png 为总览图；preview.html 为可离线打开的尺寸预览；manifest.json 为 PNG 文件清单；validation.json 为尺寸、透明通道和 ICO 帧检查结果。已核验 71 张交付 PNG 与 4 个主题 ICO 的 36 帧，并人工查看亮暗与 16–64 px 预览。尚未在实际安装后的 Windows 快捷方式、托盘或应用界面运行验证。

web/site.webmanifest 是图标配置示例，部署时合并到现有应用配置；图标为 purpose: any，并非 maskable 图标。

本包交付 PNG 和 Windows ICO，不含真正矢量 SVG、macOS ICNS 或移动端商店专用提交包。1024 px 是从清理母版统一导出的画布尺寸，不代表原始轮廓是矢量。当前任务仅交付素材，不修改应用代码或打包配置。

## 生成记录

使用内置 ImageGen 制作透明母版；使用 Node.js / Sharp 做同源颜色映射、尺寸导出和格式封装，没有逐尺寸重新生成图案。
完整母版提示词见 source/generation-prompt.txt。source/build.cjs 为可重复导出脚本，其中 Sharp 依赖路径是本机路径，换机器时需要调整。

