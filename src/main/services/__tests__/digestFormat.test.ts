import { expect, it } from 'vitest'

it('逐行要点容忍编号和中英文括号，未知ID只移除引用', async () => {
  const { parsePointLines } = await import('../digestFormat')
  expect(
    parsePointLines('\n# 主题\n\n- 原文要点 {s1}\n1. 编号要点（s2）\n2、第三条【s1】\n- 未知来源 {missing}', new Set(['s1', 's2']))
  ).toEqual({
    topic: '主题',
    points: [
      { text: '原文要点', segmentId: 's1' },
      { text: '编号要点', segmentId: 's2' },
      { text: '第三条', segmentId: 's1' },
      { text: '未知来源' }
    ]
  })
})

it('普通括号里的缩写、年份和函数参数属于正文，不能作为未知引用删除', async () => {
  const { parsePointLines } = await import('../digestFormat')
  const segmentId = '18b3f657-b4dc-4da8-9022-18bef7154988'
  const points = ['采用近端策略优化（PPO）', '使用算法 (PPO)（2026） [vector_id]', '调用 normalize(x) 与 [PPO]', '（PPO）']
  expect(parsePointLines(points.map((point) => `- ${point} {${segmentId}}`).join('\n'), new Set([segmentId]))).toEqual({
    topic: '',
    points: points.map((text) => ({ text, segmentId }))
  })
})

it('普通括号正文与未知引用并存时只移除引用，保留要点与有效来源', async () => {
  const { parsePointLines } = await import('../digestFormat')
  const segmentId = '18b3f657-b4dc-4da8-9022-18bef7154988'
  const unknownId = 'f2619e32-729b-46f7-b81c-1312a00a448d'
  for (const [open, close] of [['{', '}'], ['｛', '｝'], ['(', ')'], ['（', '）'], ['[', ']'], ['【', '】']]) {
    expect(
      parsePointLines(`- 采用（PPO） ${open}${unknownId}${close} ${open}${segmentId}${close}`, new Set([segmentId]))
    ).toEqual({ topic: '', points: [{ text: '采用（PPO）', segmentId }] })
  }
  expect(parsePointLines('- 采用（PPO） {missing} 【missing】', new Set())).toEqual({
    topic: '',
    points: [{ text: '采用（PPO）' }]
  })
})

it('要点保留前12条，按字符截到60字，空结果不伪造要点', async () => {
  const { parsePointLines } = await import('../digestFormat')
  const result = parsePointLines('# Topic\n' + Array.from({ length: 20 }, () => '- ' + '字'.repeat(70) + ' {s}').join('\n'), new Set(['s']))
  expect(result.points).toHaveLength(12)
  expect(result.points.every((p) => p.text.length === 60 && p.segmentId === 's')).toBe(true)
  expect(parsePointLines('# 只有标题', new Set()).points).toEqual([])
})

it('导图schema只约束结构，规整按层级保留45节点和有效锚点', async () => {
  const { DigestTreeSchema, normalizeMindmap } = await import('../digestFormat')
  const tree = {
    text: '根'.repeat(50),
    children: Array.from({ length: 20 }, (_, i) => ({
      text: `分支${i}` + '长'.repeat(100),
      segmentId: i ? 'missing' : 's',
      children: Array.from({ length: 20 }, () => ({ text: '节点'.repeat(200), children: [{ text: '过深' }] }))
    }))
  }
  expect(DigestTreeSchema.safeParse(tree).success).toBe(true)
  const normalized = normalizeMindmap(tree, new Set(['s']))
  expect(normalized.text).toHaveLength(12)
  expect(normalized.children).toHaveLength(8)
  expect(normalized.children?.[0].segmentId).toBe('s')
  expect(normalized.children?.[1].segmentId).toBeUndefined()
  const flat = [normalized, ...normalized.children!, ...normalized.children!.flatMap((n) => n.children ?? [])]
  expect(flat).toHaveLength(45)
  expect(flat.slice(1).every((n) => [...n.text].length <= 15)).toBe(true)
  expect(normalized.children!.flatMap((n) => n.children ?? []).every((n) => !n.children?.length)).toBe(true)
})

it('康奈尔schema接受大结果，规整为原有行数、长度与引用上限', async () => {
  const { DigestOutlineSchema, normalizeOutline } = await import('../digestFormat')
  const rows = Array.from({ length: 40 }, () => ({
    cue: '问'.repeat(300),
    body: '文'.repeat(3000),
    segmentIds: Array.from({ length: 30 }, (_, i) => `s${i}`)
  }))
  expect(DigestOutlineSchema.safeParse({ rows }).success).toBe(true)
  const result = normalizeOutline(rows, new Set(Array.from({ length: 20 }, (_, i) => `s${i}`)))
  expect(result).toHaveLength(24)
  expect(result.every((r) => r.cue.length === 200 && r.body.length === 2000 && r.segmentIds.length === 12)).toBe(true)
})

it('照原文行首写成 {ID p.3} 或多个 ID 时仍取到有效引用，不留在正文里', async () => {
  const { parsePointLines } = await import('../digestFormat')
  const a = '01a13e66-98b8-7705-b3f4-c47ebbbbe576',
    b = '01a13e66-98b8-7705-b3f4-c47ebbbbe577',
    gone = '01a13e66-98b8-7705-b3f4-c47ebbbbe999'
  expect(parsePointLines(`- 第一条 {${a} p.3}\n- 第二条 {${b}, ${a}}\n- 第三条 [${gone} p.9]`, new Set([a, b])).points).toEqual([
    { text: '第一条', segmentId: a },
    { text: '第二条', segmentId: b },
    { text: '第三条' }
  ])
})
