---
name: code-steps
description: 把一段代码做成“分步讲解动画”插入笔记：逐步高亮执行到的行、讲解每一步、展示变量变化。用户要求“讲讲这段代码 / 演示算法过程 / 一步步执行给我看”时使用。
metadata:
  title: 代码分步讲解
  surfaces: workspace,chat,selection
---

# 代码分步讲解

目标是让读者**看着代码一步步“跑”起来**，理解执行过程，而不是逐行翻译代码。

## 步骤

1. **准备代码**：使用用户提供或笔记中的代码；需要自己写示例时，保持在 30 行以内，只保留与讲解相关的部分。`language` 填 `python`、`javascript`、`java`、`cpp` 等。
2. **设计步骤**（4～12 步为宜）：
   - 按**实际执行顺序**，而不是代码书写顺序（循环要展示几次迭代，递归要展示调用与返回）；
   - 每步 `lines` 只高亮这一步执行的 1～3 行（行号从 1 开始，必须在代码范围内）；
   - `note` 用一两句话说明“这一步做了什么、为什么”，不超过 80 字；
   - 变量有变化时写进 `vars`（如 `{"i": "2", "arr": "[1, 3, 5, 8]"}`），值写成字符串。
3. 第一步讲输入和目标，最后一步讲结果与关键结论（如时间复杂度）。
4. 调用 `note_add_code_steps`。如果返回“引用了不存在的行”，修正行号后再次调用。
5. 回复一句话。

## 示例（二分查找的前两步）

```json
{
  "language": "python",
  "code": "def search(arr, x):\n    lo, hi = 0, len(arr) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if arr[mid] == x:\n            return mid\n        if arr[mid] < x:\n            lo = mid + 1\n        else:\n            hi = mid - 1\n    return -1",
  "steps": [
    { "lines": [2], "note": "在 [1, 3, 5, 8, 13] 中找 8：先把搜索范围设为整个数组。", "vars": { "lo": "0", "hi": "4" } },
    { "lines": [4], "note": "取中间位置 2，arr[2] = 5。", "vars": { "mid": "2" } }
  ]
}
```
