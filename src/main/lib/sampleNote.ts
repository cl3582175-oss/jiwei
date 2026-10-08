import type { DocJSON, DocNode } from '@shared/types'

// 示例笔记：《如何使用康奈尔笔记法》——它本身就是一篇按康奈尔法写成的笔记。

const p = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const bold = (b: string, rest: string): DocNode => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: b, marks: [{ type: 'bold' }] },
    { type: 'text', text: rest }
  ]
})
const list = (items: string[]): DocNode => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [p(t)] })) })
const row = (cue: DocNode[], body: DocNode[]): DocNode => ({
  type: 'cornellRow',
  content: [
    { type: 'cornellCue', content: cue },
    { type: 'cornellBody', content: body }
  ]
})

const zh = {
  title: '如何使用康奈尔笔记法',
  doc: {
    type: 'doc',
    content: [
      row(
        [p('康奈尔笔记是什么？')],
        [
          p('一种把一页笔记分成三块的方法，由康奈尔大学的 Walter Pauk 提出：'),
          list(['右侧「笔记栏」：记录要点、例子、推导', '左侧「线索栏」：写下关键词和问题', '底部「总结栏」：用几句话概括整页'])
        ]
      ),
      row([p('听课 / 读书时怎么记？')], [p('只写右侧的笔记栏。抓要点，用自己的话，留出空白——不求完整，求能看懂。')]),
      row(
        [p('课后怎么用线索栏？')],
        [
          p('重读一遍笔记，在左侧写下能“引出”这段内容的问题。'),
          bold('复习时', '遮住右边，只看问题回忆答案——这就是主动回忆，比反复阅读有效得多。')
        ]
      ),
      row([p('总结有什么用？')], [p('用 2–3 句话写出这一页的核心。写不出来，说明还没有真正理解。')]),
      row(
        [p('在积微里的小技巧')],
        [
          list([
            '⌘/Ctrl + Enter：新增一行知识点',
            'Tab / Shift + Tab：在线索与笔记之间切换',
            '可以直接粘贴或拖入图片',
            '把鼠标停在一行上，能看到它最后修改的时间',
            '右上角可以在左侧打开资料，边看边记'
          ])
        ]
      )
    ].concat([{ type: 'cornellSummary', content: [p('记录 → 提问 → 回忆 → 总结：用输出检验输入。')] }])
  } as DocJSON
}

const en = {
  title: 'How to use the Cornell method',
  doc: {
    type: 'doc',
    content: [
      row(
        [p('What is the Cornell method?')],
        [
          p('A way of dividing a page into three parts, devised by Walter Pauk at Cornell University:'),
          list([
            'Notes (right): key points, examples, derivations',
            'Cues (left): keywords and questions',
            'Summary (bottom): the page in a few sentences'
          ])
        ]
      ),
      row(
        [p('During a lecture or reading?')],
        [p('Write only in the notes column. Capture key points in your own words and leave space — aim to understand, not to transcribe.')]
      ),
      row(
        [p('After class: the cue column')],
        [
          p('Re-read your notes and write questions on the left that would prompt each part.'),
          bold('When reviewing, ', 'cover the right side and answer from the questions — active recall beats re-reading.')
        ]
      ),
      row([p('Why a summary?')], [p("Write the core of the page in 2–3 sentences. If you can't, you haven't understood it yet.")]),
      row(
        [p('Tips in Jiwei')],
        [
          list([
            '⌘/Ctrl + Enter: add a row',
            'Tab / Shift + Tab: switch between cue and notes',
            'Paste or drop images directly',
            'Hover a row to see when it was last edited',
            'Open a source on the left to read and write side by side'
          ])
        ]
      )
    ].concat([{ type: 'cornellSummary', content: [p('Record → question → recall → summarize: test your input with output.')] }])
  } as DocJSON
}

export function sampleNote(lang: string): { title: string; doc: DocJSON } {
  return lang.startsWith('zh') ? zh : en
}
