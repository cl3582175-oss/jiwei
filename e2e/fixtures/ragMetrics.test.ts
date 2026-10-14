import { describe, expect, it } from 'vitest'
import { scoreQuestion, summarize, normalizeGold, type RagQuestion, type EvalHit } from './ragMetrics'

const question: RagQuestion = {
  id: 'S1-001',
  scenario: 'S1',
  subtype: 'clause',
  q: '冷却系统的验收条件是什么？',
  gold: [{ title: '合成试验', quote: '温度必须低于四十摄氏度' }],
  gated: 'v0.14.5'
}
const hit = (text = '温度必须低于四十摄氏度', title = '合成试验规范'): EvalHit => ({
  text,
  title,
  parentType: 'source',
  parentId: 'source-a',
  ownerId: 'segment-a',
  score: 0.03
})

describe('真实语料评测的独立检索与计分', () => {
  it('不能用 30 条命中替代真实 8 条查询', () => {
    const r = scoreQuestion(question, [], [hit()], { ms8: 10, ms30: 20, scopeIds: [] })
    expect(r.rank8).toBeNull()
    expect(r.rank30).toBe(1)
    const s = summarize([r])
    expect(s.overall.recall8).toBe(0)
    expect(s.overall.recall30).toBe(1)
    expect(s.overall.mrr8).toBe(0)
  })
  it('原文与资料标题都必须匹配，章节路径参与原文匹配', () => {
    const q = { ...question, gold: [{ title: '合成试验', quote: '第三章 冷却装置' }] }
    const r = scoreQuestion(q, [hit(undefined, '其他试验'), { ...hit('正文'), heading: '第三章 冷却装置' }], [], {
      ms8: 1,
      ms30: 2,
      scopeIds: []
    })
    expect(r.rank8).toBe(2)
  })
  it('对金标和命中文字执行规定的规范化，保留作者标点', () => {
    expect(normalizeGold('⼈⽆⾦Ｘ２０２６\u200b\u00a0条件（甲）')).toBe('人无金X2026 条件（甲）')
    const q = { ...question, gold: [{ title: '合成试验', quote: '人工检验记录编号A102' }] }
    expect(scoreQuestion(q, [hit('⼈工检验记录编号Ａ１０２')], [], { ms8: 1, ms30: 2, scopeIds: [] }).rank8).toBe(1)
  })
  it('列举覆盖率按金标资料计，不按重复片段计', () => {
    const q = { ...question, goldAll: [{ title: '合成试验' }, { title: '第二份方案' }] }
    const r = scoreQuestion(q, [], [hit(), hit(), hit(undefined, '第二份方案说明')], { ms8: 1, ms30: 2, scopeIds: [] })
    expect(r.coverage30).toBe(1)
  })
  it('有限部首例外不会把正确的风压命中计为失败', () => {
    const q = { ...question, gold: [{ title: '合成试验', quote: '合成⻛压条件' }] }
    expect(scoreQuestion(q, [hit('合成风压条件')], [], { ms8: 1, ms30: 2, scopeIds: [] }).rank8).toBe(1)
  })
  it('分别记录 8 条与 30 条查询的范围越界', () => {
    const q = { ...question, subtype: 'scoped', scope: ['合成试验'] }
    const r = scoreQuestion(q, [hit()], [{ ...hit(), parentId: 'outside' }], { ms8: 1, ms30: 2, scopeIds: ['source-a'] })
    expect(r.outOfScope8).toBe(0)
    expect(r.outOfScope30).toBe(1)
  })
  it('未接入的个人数据仍记零分并保留原因', () => {
    const r = scoreQuestion({ ...question, unavailable: 'mistake' }, [], [], { ms8: 0, ms30: 0, scopeIds: [] })
    expect(summarize([r]).overall.recall8).toBe(0)
    expect(r.unavailable).toBe('mistake')
  })
  it('无答案问题记录原始检索分数，不把 RRF 当成语义相似度', () => {
    const q = { ...question, gold: [], expectNone: true }
    const r = scoreQuestion(q, [hit()], [], { ms8: 1, ms30: 2, scopeIds: [] })
    expect(r.highestRetrievalScore).toBe(0.03)
    expect(summarize([r]).overall.answerable).toBe(0)
    expect(summarize([r]).overall.recall8).toBeNull()
  })
  it('按场景和题型分组保留真实耗时及失败题', () => {
    const rows = [
      scoreQuestion(question, [hit()], [hit()], { ms8: 10, ms30: 15, scopeIds: [] }),
      scoreQuestion({ ...question, id: 'S2-001', scenario: 'S2', subtype: 'scoped' }, [], [], { ms8: 30, ms30: 35, scopeIds: [] })
    ]
    const s = summarize(rows)
    expect(s.byScenario.S1.recall8).toBe(1)
    expect(s.byScenario.S2.recall8).toBe(0)
    expect(s.bySubtype.scoped.recall30).toBe(0)
    expect(s.failures.map((r) => r.id)).toEqual(['S2-001'])
    expect(s.overall.latency8.p95).toBe(30)
  })
})
