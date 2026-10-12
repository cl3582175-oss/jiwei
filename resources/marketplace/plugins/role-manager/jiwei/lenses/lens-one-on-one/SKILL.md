---
name: lens-one-on-one
description: 一对一：从对应录音提取指定事项，逐条附原声证据。
metadata:
  kind: lens
  title: 一对一
  output: items
  landing: todos
  scenes: meeting
---

# 一对一

提取：对方的关切与原话、双方的承诺（谁、做什么、截止日期原话）、需要我跟进的事；对情绪只记录对方明确说出的，不推测。

- 关切用 item，双方明确承诺用 action。没有说出情绪就不要猜；没有给负责人或截止日期就省略 owner、dueQuote。
- 输出 items；每条包含 title、body、category 和 evidence。使用本次转写提供的 u 数字引用，每条一到八个；不能编造引用或用上次摘要代替本次证据。
- 一条只记一个意思；title 概括，body 保留条件、否定和承诺强度，quote 只复制原话，不改写引号内的内容。
- 没有承诺或指派的材料用 item；明确行动才用 action。owner 只写原话姓名或已有说话人标签；dueQuote 只复制截止时间原话，不计算日期。
- 不补背景知识、不推测动机、不推断完成状态；缺信息就省略字段，不用常识补齐。
- 没有符合条件的内容返回空 items，不凑条目。落地由现有审阅与确认机制处理，不宣称已保存。
- 用转写稿的主要语言输出。
