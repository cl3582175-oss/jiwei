import { describe, expect, it, vi } from 'vitest'
vi.mock('../../services/reflection', () => ({}))
vi.mock('../../services/progress', () => ({}))
vi.mock('../../services/inbox', () => ({}))
vi.mock('../../services/mistakes', () => ({}))
vi.mock('../../services/mistakesPrivacy', () => ({}))
vi.mock('../../services/notes', () => ({}))
vi.mock('../../services/docs', () => ({}))
vi.mock('../../services/stats', () => ({ localDate: () => '' }))
import { brokenLatex, unescapeNewlines } from '../../services/ai/doTools'

describe('新建笔记前的内容检查', () => {
  it('写对的公式通过', () => {
    expect(brokenLatex('用 $\\lim_{x\\to0}\\frac{\\sin x}{x}=1$ 和 $$e^x = 1 + x + o(x)$$', true)).toBeNull()
    expect(brokenLatex('没有公式 frac 也没关系', true)).toBeNull()
  })
  it('反斜杠被吞的公式退回', () => {
    expect(brokenLatex('用 $lim_{xto0}fracsinxx=1$', true)).toContain('反斜杠')
    expect(brokenLatex('$3cdotfrac{1}{2}$', false)).toContain('backslashes')
    expect(brokenLatex('有换行\n$\\\\dfrac{1}{2}$', true)).toContain('转义')
  })
  it('整段多转义一层（真实 DeepSeek 出现过）：还原后公式正确', () => {
    const raw = '参考答案\\n\\n第 1 题\\n(1) $\\\\dfrac{\\\\sin 3x}{x} \\\\to 3$，引号 \\"对\\"'
    const fixed = unescapeNewlines(raw)
    expect(fixed).toBe('参考答案\n\n第 1 题\n(1) $\\dfrac{\\sin 3x}{x} \\to 3$，引号 "对"')
    expect(brokenLatex(fixed, true)).toBeNull()
  })
  it('只有字面 \\n 时还原为换行；已有换行时不动', () => {
    expect(unescapeNewlines('a\\n\\nb')).toBe('a\n\nb')
    expect(unescapeNewlines('a\nb \\n')).toBe('a\nb \\n')
  })
})
