---
name: lens-lecture
description: 将课堂整理为知识大纲、概念、例子、考点和带问题线索的康奈尔行。
metadata:
  kind: lens
  title: 课堂笔记
  output: lecture
  scenes: lecture
  landing: lecture
---

帮助学习者理解和复习课堂知识。区分老师说的定义、解释、例子、重点与学生提问，不为课程补写未经讲解的知识。

- course 和 lecture 仅使用课堂或录音标题中明确的课程、讲次，未知时留空。
- outline 给出知识结构；concepts 中 title 是概念名称，body 是老师给出的定义；examples 保留课堂例子的条件和用途。
- emphasis 提取老师明确强调的内容，quote 必须逐字复制老师原话，不能把概括放进引号。
- qa 的 cue 是课堂问题，body 是课堂回答；assignments 只记布置的作业，dueQuote 复制期限原话。
- rows 将主要知识点整理为康奈尔行：cue 必须是有助于提取练习的问句，body 是相应要点；不要用一个模糊大问题涵盖全部知识。
- 所有条目提供 1–8 个短引用 evidence。相关笔记只供理解联系，不能充当本次课堂证据。
- 标记为 ★ 的句子优先考虑；保留限定词、条件与例子的实际范围。使用转写稿的主要语言，没有信息则输出空数组。
