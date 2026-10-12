# 积微图标 · Icon Composer 分层

三层 SVG，1024×1024 满版、无圆角、无阴影与高光——圆角遮罩、玻璃反光、折射、投影都由系统在 Icon Composer 中生成。

| 文件 | 层 | 说明 |
|---|---|---|
| 0-background.svg | 背景 | 青玉绿渐变；也可在 Icon Composer 里直接设背景色 `#1f6f69 → #0c3b39` 代替 |
| 1-vessel.svg | 中层 | 器皿与三层水位（宣纸白 `#f4efe4`） |
| 2-drop.svg | 前景 | 金色水滴（`#ffe3a0 → #e2a740`），玻璃高光最明显的一层 |

## 步骤
1. 打开 Icon Composer（Xcode 26 自带，或从 Apple Design Resources 单独下载）。
2. 新建图标，把背景设为 0-background.svg（或填纯色/渐变），把 1-vessel.svg、2-drop.svg 依次拖成两个 group。
3. 给 2-drop 开启 Specular、适当加 Translucency；1-vessel 保持不透明。
4. 在 Default / Dark / Clear / Tinted 四种外观下预览，Dark 下可把水位条透明度调高。
5. 导出 `.icon` 文件。Electron 打包仍使用 `build/icon.icns`；若要在 macOS 26 显示 Liquid Glass 效果，需将 `.icon` 编译进 Assets.car 并在 Info.plist 设置 `CFBundleIconName`。
