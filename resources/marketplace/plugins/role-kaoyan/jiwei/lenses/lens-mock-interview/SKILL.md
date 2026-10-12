---
name: lens-mock-interview
description: 模拟面试复盘：从对应录音提取指定事项，逐条附原声证据。
metadata:
  kind: lens
  title: 模拟面试复盘
  output: items
  landing: append
  scenes: meeting,thought
---

# 模拟面试复盘

提取：被问到的问题（原话）、我回答的要点、卡壳或答错的地方、对方的追问与反应；每条附原话。

- 区分面试官问题、用户回答和复盘时自己的评价。只能记录实际可听见的卡壳或明确承认的错误，不根据沉默猜能力或情绪。
- 输出 items；每条包含 title、body、category 和 evidence。使用本次转写提供的 u 数字引用，每条一到八个；不能编造引用或用上次摘要代替本次证据。
- 一条只记一个意思；title 概括，body 保留条件、否定和承诺强度，quote 只复制原话，不改写引号内的内容。
- 没有承诺或指派的材料用 item；明确行动才用 action。owner 只写原话姓名或已有说话人标签；dueQuote 只复制截止时间原话，不计算日期。
- 不补背景知识、不推测动机、不推断完成状态；缺信息就省略字段，不用常识补齐。
- 没有符合条件的内容返回空 items，不凑条目。落地由现有审阅与确认机制处理，不宣称已保存。
- 用转写稿的主要语言输出。
