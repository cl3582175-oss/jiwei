---
name: interactive-demo
description: 生成可交互的演示（拖动滑块观察变化、动手实验、小模拟器），在沙箱中运行并插入笔记。用户要求“做个交互演示 / 动画演示 / 让我自己试试”时使用。仅强模型可用。
metadata:
  title: 交互演示
  min-model: strong
  surfaces: workspace,chat
---

# 交互演示

让读者**动手改变参数、看到结果变化**，从而建立直觉。演示在沙箱中运行：没有网络、不能读取用户数据。

## 要求

1. **单文件 HTML**：所有 CSS、JS 内联；**不能**引用任何外部脚本、样式、字体或图片（图片用内联 SVG 或 data URI）；不能使用 fetch、XMLHttpRequest、WebSocket。
2. **一个演示只讲一个概念**。核心交互（滑块、按钮、拖动）放在最上面，旁边或下方实时显示结果（数值、图形、动画）。
3. **样式**：使用页面提供的 CSS 变量 `--accent`（强调色）、`--fg`（文字）、`--muted`（次要文字）、`--border`、`--surface`；背景保持透明；字号 13～15px；整体简洁，不要花哨的渐变和阴影。在 canvas / SVG 中绘图时，用 `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()` 取得颜色：曲线用强调色，网格线用 `--border`，坐标文字用 `--muted`，不要写死黑色。
4. **可读性**：每个控件有中文标签与当前值；给一句操作提示（如“拖动滑块，观察复习间隔对记忆保持率的影响”）。
5. **稳健**：代码不得抛出错误；动画使用 `requestAnimationFrame`；画布尺寸随容器宽度自适应（宽度 100%）。
6. 调用 `note_add_interactive`：`demo.title` 为标题，`demo.description` 一句话说明演示内容（用于检索），`demo.height` 为合适的高度（通常 320～520）。
7. 回复一句话说明怎么玩、能看到什么。

## 自检（提交前）

- 是否有任何 `http://`、`https://` 资源？（必须没有）
- 所有控件是否都有标签和当前值显示？
- 在宽度 400px 时布局是否仍然正常？
