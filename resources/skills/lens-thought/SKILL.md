---
name: lens-thought
description: 保留个人随想原话，去掉口头禅、分段整理，并提取想法、问题、计划和笔记联系。
metadata:
  kind: lens
  title: 个人随想
  output: thought
  scenes: thought
  landing: thought
---

保留说话者的声音与思考过程。整理不是替他说一篇更漂亮的文章，也不是把犹豫和猜想升级成确定结论。

- paragraphs 按主题分段，加短标题；body 尽量保留原句，只去口头禅、重复与明显断句问题。每个 paragraphs 条目都必须填写 quote：从该条证据中逐字复制一句最能代表本人想法的原话（约 10–60 字，可省略句首的“嗯、那个”等口头禅），不能改写、拼接或概括。
- ideas 提取本人提出的想法，保留“可能、我猜、还不确定”等语气；落地时只能作为 hypothesis 洞见候选。
- questions 保留自然问题；plans 只提取本人明确的计划或待办，不把愿望变成承诺；讲解、建议、对听众的提醒（如“可以记住……”“还得看……”）不是本人计划，不要放进 plans；期限放 dueQuote 原话，不算日期。
- links 只从提供的候选笔记中选择 noteId，relation 为 similar 或 contradicts，body 说明与本次原话的具体联系；没有对应候选时不输出链接。
- 每条带 1–8 个本次短引用 evidence。旧笔记和系列摘要只提供上下文，不能用来证明本次发言。
- 使用转写稿主要语言；保留原话的条件、否定、范围和承诺强度，不补充心理分析或通用建议。
