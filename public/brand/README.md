# Scientify 品牌素材

来源：[docs/营销思路/Scientify-Logo-Kit](../../docs/营销思路/Scientify-Logo-Kit/README.md)，与源码同处本仓库。

- `scientify-light.png`：`app/light/scientify-96.png`，浅色界面使用，墨黑单色。
- `scientify-dark.png`：`app/dark/scientify-96.png`，深色界面使用，白色箱体配荧光绿圆点。
- `BrandMark` 按应用 `.dark` 主题切换，顶栏显示 24 CSS px，Projects 启动页侧栏显示 32 CSS px；96 px 素材在两处都满足 2 倍像素密度。
- `public/favicon.ico` 来自素材包 `web/favicon.ico`。
- `src-tauri/icons/icon.ico` 由素材包的原始 PNG 帧无损封装，用于 Windows 程序、窗口、任务栏及安装包；深色底板，可用于不同桌面背景。256 px 必须排第一，否则 Tauri 2 会取 16 px 帧放大为窗口图标。
- 其余 Tauri 平台图标通过 `pnpm tauri icon <素材包>/desktop/dark/scientify-1024.png --output src-tauri/icons --ios-color "#111A17"` 生成；随后运行 `node scripts/prepare-icons.mjs` 生成 Windows ICO，不能直接用素材包 ICO 覆盖。源帧保存在 `src-tauri/icons/source/`：`scientify.ico` 取自素材包 `desktop/scientify.ico`，`scientify-96.png`、`scientify-192.png` 取自 `desktop/dark/`。开发及构建前自动检查并生成，包含 16–256 px 共 11 帧。

更新原生图标需要重新构建桌面程序。已运行进程和 Windows 已缓存的固定快捷方式不会随着网页热更新自动更换图标。
