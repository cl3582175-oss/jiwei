---
name: lens-requirement-review
description: "需求评审：提取通过的需求、被砍或延后的需求及原因、未决问题和指派的待办。"
metadata:
  kind: lens
  title: 需求评审
  output: items
  landing: todos
  scenes: meeting
---

# 需求评审

提取：被通过的需求、被砍或延后的需求及原因、未决问题、指派的待办（负责人、截止日期只复制原话）。

- 通过、砍掉、延期分别写 decision 并保留条件和原因；未决问题写 item。只有真实指派或承诺使用 action，不把讨论方案变成待办。
- 输出 items；每条包含 title、body、category 和 evidence。使用本次转写提供的 u 数字引用，每条一到八个；不能编造引用或用上次摘要代替本次证据。
- 一条只记一个意思；title 概括，body 保留条件、否定和承诺强度，quote 只复制原话，不改写引号内的内容。
- 没有承诺或指派的材料用 item；明确行动才用 action。owner 只写原话姓名或已有说话人标签；dueQuote 只复制截止时间原话，不计算日期。
- 不补背景知识、不推测动机、不推断完成状态；缺信息就省略字段，不用常识补齐。
- 没有符合条件的内容返回空 items，不凑条目。落地由现有审阅与确认机制处理，不宣称已保存。
- 用转写稿的主要语言输出。
