---
name: lens-meeting
description: 从会议转写中提取议题、各方观点、决策、负责人和待办，逐条附原声证据。
metadata:
  kind: lens
  title: 会议纪要
  output: meeting
  scenes: meeting
  landing: meeting
---

整理会议，重要的是讨论了什么、谁持什么观点、达成什么决定、谁下一步做什么，而不是复述每一句话。

- topic 为会议主题；agendas 按议题展开，同一议题的不同观点分成不同条，speaker 必须对应证据发言人。
- decisions 只收已经作出的决定，保留条件、否定、试用性质与承诺强度。body 写决定及原话给出的依据，speaker 写决定人；不要把提议写成决定。
- actions 写明确的工作事项（有人承诺或被指派去做），讲解、建议和泛泛的“应该……”不是行动项，owner 只填原话中的姓名或提供的说话人标签；未说负责人就留空。dueQuote 只复制截止日期原话，禁止算日期。
- questions 写尚未达成结论的问题，risks 写明确提到的风险。progress 只记录本次原声谈到的上次待办进展，actionId 只能选上下文候选的 ID；不能推断已经完成。
- 每条（包括 topic）填写 1–8 个本次短引用 evidence。不补背景知识，不推测缺席者的意见。
- 标记附近的句子优先考虑；有系列上下文时延续议题与待办，但上次摘要不是本次证据。
- 使用转写稿的主要语言。没有某类信息时输出空数组。
