// 手写、可独立核对的目录样例；同时用于受控模型和评测，不能据此计算预期结果。
export const samples = {
  columns: {
    type: 'columns',
    children: [
      { type: 'list', items: [{ text: '甲' }] },
      { type: 'list', items: [{ text: '乙' }] }
    ]
  },
  tabs: {
    type: 'tabs',
    tabs: [
      { label: '甲', children: [{ type: 'list', items: [{ text: '甲' }] }] },
      { label: '乙', children: [{ type: 'list', items: [{ text: '乙' }] }] }
    ]
  },
  details: { type: 'details', summary: '展开', children: [{ type: 'list', items: [{ text: '说明' }] }] },
  stat: { type: 'stat', items: [{ label: '进度', value: 80, unit: '%' }] },
  table: { type: 'table', columns: [{ key: 'n', label: '人数', kind: 'number' }], rows: [{ n: 3 }] },
  list: { type: 'list', items: [{ text: '检查证据' }], checkable: true },
  steps: { type: 'steps', items: [{ title: '先查' }, { title: '再做', detail: '检查后实施' }] },
  chart: { type: 'chart', kind: 'bar', categories: ['一', '二'], series: [{ name: '次数', data: [2, 3] }] },
  diagram: { type: 'diagram', code: 'flowchart LR\nA-->B' },
  timeline: {
    type: 'timeline',
    events: [
      { date: '第一天', title: '调查' },
      { date: '第二天', title: '完成' }
    ]
  },
  codesteps: { type: 'codesteps', language: 'js', code: 'const x = 1', steps: [{ lines: [1], note: '声明变量' }] },
  choice: {
    type: 'choice',
    question: '哪个？',
    options: [
      { label: '甲', value: 'a' },
      { label: '乙', value: 'b' }
    ]
  },
  form: { type: 'form', fields: [{ key: 'hours', label: '时数', kind: 'number', required: true }] },
  calc: {
    type: 'calc',
    inputs: [{ key: 'x', label: '输入', kind: 'slider', min: 0, max: 10, step: 1, value: 2 }],
    outputs: [{ label: '两倍', expr: 'x*2' }]
  },
  quiz: { type: 'quiz', items: [{ q: '1+1？', options: ['1', '2'], answer: 1, explain: '相加得到 2' }] },
  flashcards: { type: 'flashcards', cards: [{ front: '问题', back: '答案' }] },
  cloze: { type: 'cloze', text: '地球绕{{太阳}}公转。' },
  schedule: {
    type: 'schedule',
    range: { from: '2026-10-19', to: '2026-10-25' },
    proposals: [{ title: '复习', start: '2026-10-19T19:00', end: '2026-10-19T21:00' }]
  },
  tasks: { type: 'tasks', drafts: [{ title: '检查结果', due: '2026-10-20' }] },
  note: { type: 'note', noteId: 'note-1', rowIds: ['row-1'] },
  excerpt: { type: 'excerpt', cite: 1 },
  mastery: { type: 'mastery', scope: { kind: 'all' } },
  decision: {
    type: 'decision',
    question: '选谁？',
    options: [
      { id: 'a', title: '甲' },
      { id: 'b', title: '乙' }
    ],
    criteria: [
      { name: '质量', weight: 5 },
      { name: '速度', weight: 3 }
    ],
    scores: [
      { option: 'a', criterion: '质量', score: 5 },
      { option: 'b', criterion: '速度', score: 3 }
    ]
  },
  usage: { type: 'usage', range: 'month' }
} as const

export const invalid = {
  columns: { ...samples.columns, ratio: '1:1:1' },
  tabs: { ...samples.tabs, tabs: [] },
  details: { ...samples.details, children: [] },
  stat: { ...samples.stat, items: [] },
  table: { ...samples.table, rows: [{ unknown: 4 }] },
  list: { ...samples.list, items: [] },
  steps: { ...samples.steps, current: 5 },
  chart: { ...samples.chart, series: [{ name: '次数', data: [2] }] },
  diagram: { ...samples.diagram, code: 'bad' },
  timeline: { ...samples.timeline, events: [] },
  codesteps: { ...samples.codesteps, steps: [{ lines: [2], note: '不存在的行' }] },
  choice: {
    ...samples.choice,
    options: [
      { label: '甲', value: 'a' },
      { label: '乙', value: 'a' }
    ]
  },
  form: { ...samples.form, fields: [{ key: 'x', label: 'x', kind: 'slider' }] },
  calc: { ...samples.calc, outputs: [{ label: '错', expr: 'unknown+1' }] },
  quiz: { ...samples.quiz, items: [{ ...samples.quiz.items[0], answer: 2 }] },
  flashcards: { ...samples.flashcards, cards: [] },
  cloze: { ...samples.cloze, text: '没有空格' },
  schedule: { ...samples.schedule, range: { from: '2026-02-30', to: '2026-03-01' } },
  tasks: { type: 'tasks' },
  note: { type: 'note' },
  excerpt: { ...samples.excerpt, segmentId: 'segment-1' },
  mastery: { ...samples.mastery, scope: { kind: 'goal' } },
  decision: { ...samples.decision, scores: [{ option: 'missing', criterion: '质量', score: 4 }] },
  usage: { ...samples.usage, range: 'year' }
} as const
