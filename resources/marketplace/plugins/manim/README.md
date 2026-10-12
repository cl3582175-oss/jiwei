# 数学动画（Manim）

用 Manim 生成数学动画，用在讲解视频和笔记里。

## 能做什么

- **公式逐步推导**：每一步的式子平滑变形到下一步，配一句说明。
- **函数平移伸缩**：看清 y=f(x) 平移、伸缩、对称时图像怎么变。
- **几何作图**：点、线段、圆、多边形、角按顺序画出来。
- **数轴与区间**：不等式的解集、开闭端点一目了然。

讲解视频的分镜里会多出“数学动画”场景；助手也可以在笔记里插入动画。

## 运行环境

- 首次使用要在本插件的管理页里下载运行环境：约 170 MB 下载，装好后约 0.9 GB（本机已有完整 LaTeX 时约 0.75 GB）。下载完会清理安装包。
- 优先使用清华、中科大的 conda-forge 镜像，每个包都按锁定的 sha256 校验。
- 运行环境放在积微自己的数据目录里，不会改动你电脑上已有的 Python、Manim 或 LaTeX；不用了可以一键删除。
- 渲染时禁止联网、只能写临时目录。
- 目前只支持 macOS（Apple 芯片和 Intel）。

## 许可

Manim Community（MIT）、Python、cairo/pango（LGPL）、ffmpeg（LGPL 版本）等均从 conda-forge 下载，各自遵循其许可证；TinyTeX 与 TeX Live 包从 CTAN 镜像下载。

---

## Math animation (Manim)

Animated derivations, function transforms, geometry constructions and number lines for explainer videos and notes. The runtime (about 170 MB download, about 0.9 GB installed) is downloaded on demand into Jiwei's own data folder, verified package by package, and can be removed in one click. Rendering runs offline in a sandbox. macOS only for now.
