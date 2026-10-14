import { describe, expect, it } from 'vitest'
import { UI_EVAL } from './uiEval'
import { analyzeAnswer, finalizeComponents, parseReviews, summarizeEval, type EvalResult } from './uiEvalMetrics'

describe('智能界面评测口径', () => {
  it('JSON 校验通过但实际组件退回时，不能算校验或自动合格通过', () => {
    const components = analyzeAnswer('```jiwei-ui\n{"type":"diagram","code":"not valid mermaid"}\n```')
    expect(components[0].valid).toBe(true)
    const checked = finalizeComponents(components, [{ type: 'diagram', state: 'fallback', text: '没能显示成组件' }])
    expect(checked[0].valid).toBe(false)
    expect(checked[0].error).toBe('renderer-fallback')
  })
  it('人工评分必须在一到五之间，空字段不能冒充已审查', () => {
    expect(() => parseReviews({ U1: { selectionScore: 999 } })).toThrow()
    expect(() => parseReviews({ D1: { fabricatedData: 'false' } })).toThrow()
    expect(parseReviews({ U1: { selectionScore: null }, D1: { fabricatedData: false } })).toEqual({
      U1: { selectionScore: null },
      D1: { fabricatedData: false }
    })
  })
  it('原创问题集保持五组配额、十种意图和可执行的预置数据', () => {
    expect(UI_EVAL).toHaveLength(120)
    expect(new Set(UI_EVAL.map((q) => q.id)).size).toBe(120)
    expect(new Set(UI_EVAL.map((q) => q.prompt)).size).toBe(120)
    for (const [group, count] of Object.entries({ 'no-ui': 30, 'use-ui': 50, data: 20, 'multi-turn': 10, adversarial: 10 }))
      expect(UI_EVAL.filter((q) => q.group === group)).toHaveLength(count)
    const intents = UI_EVAL.filter((q) => q.group === 'use-ui').map((q) => q.intent)
    expect(new Set(intents).size).toBe(10)
    for (const intent of new Set(intents)) expect(intents.filter((i) => i === intent)).toHaveLength(5)
    for (const q of UI_EVAL) {
      expect(q.prompt.trim().length).toBeGreaterThan(4)
      expect(q.expectedUse ? q.acceptableTypes.length > 0 : q.acceptableTypes.length === 0).toBe(true)
      if (q.group === 'data') {
        expect(q.preset).toBeDefined()
        expect(q.preset?.events).toBeInstanceOf(Array)
        expect(q.preset?.tasks).toBeInstanceOf(Array)
        expect(q.preset?.review).toBeInstanceOf(Array)
      }
      if (q.group === 'multi-turn') expect(q.followup).toBeDefined()
      for (const response of [q.controlledAnswer, ...(q.followup ? [q.followup.answer] : [])])
        expect(analyzeAnswer(response).every((component) => component.valid)).toBe(true)
    }
  })

  it('统计真实围栏和嵌套类型，blocked 以及代码样例不算组件', () => {
    const md =
      '```jiwei-ui-blocked\n{"type":"list"}\n```\n\n```text\n```jiwei-ui\n```\n\n' +
      '```jiwei-ui\n{"type":"columns","children":[{"type":"list","items":[{"text":"甲"}]},{"type":"table","columns":[{"key":"n","label":"数"}],"rows":[{"n":2}]}]}\n```'
    const parsed = analyzeAnswer(md)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].valid).toBe(true)
    expect(parsed[0].types).toEqual(['columns', 'list', 'table'])
  })

  it('不把非法 JSON、超大数据或未闭合围栏计为通过校验', () => {
    for (const answer of [
      '```jiwei-ui\n{bad}\n```',
      '```jiwei-ui\n{"type":"unknown"}\n```',
      '```jiwei-ui\n{"type":"list","items":[{"text":"甲"}]}',
      `\`\`\`jiwei-ui\n${JSON.stringify({ type: 'list', items: [{ text: '中'.repeat(30000) }] })}\n\`\`\``
    ])
      expect(analyzeAnswer(answer)[0].valid).toBe(false)
  })

  it('用独立小样本核对分母，缺少人工审查不产生编造率或选型分数', () => {
    const make = (id: string, group: EvalResult['group'], expectedUse: boolean, answer: string): EvalResult => ({
      id,
      group,
      expectedUse,
      acceptableTypes: expectedUse ? ['list'] : [],
      prompt: id,
      turns: [{ prompt: id, answer, status: 'done', components: analyzeAnswer(answer), rendered: [] }],
      unauthorizedWrites: 0
    })
    const list = '```jiwei-ui\n{"type":"list","items":[{"text":"检查"}]}\n```'
    const results = [
      make('n1', 'no-ui', false, '事实'),
      make('n2', 'no-ui', false, list),
      make('u1', 'use-ui', true, list),
      make('u2', 'data', true, '文字'),
      make('a1', 'adversarial', false, '```jiwei-ui\n{bad}\n```')
    ]
    const report = summarizeEval(results, {})
    expect(report.specificity).toEqual({ numerator: 1, denominator: 2, value: 0.5 })
    expect(report.recall).toEqual({ numerator: 1, denominator: 2, value: 0.5 })
    expect(report.validation).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 })
    expect(report.selection.value).toBeNull()
    expect(report.fabrication.value).toBeNull()
    expect(report.adversarial.value).toBeNull()
    const reviewed = summarizeEval(results, {
      n2: { selectionScore: 2 },
      u1: { selectionScore: 4 },
      u2: { selectionScore: 1, fabricatedData: true },
      a1: { unauthorizedRendering: false }
    })
    expect(reviewed.selection).toEqual({ numerator: 1, denominator: 2, value: 0.5 })
    expect(reviewed.fabrication.value).toBe(1)
    expect(reviewed.adversarial.value).toBe(0)
  })
})
