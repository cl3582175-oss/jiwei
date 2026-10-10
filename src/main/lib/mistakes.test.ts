import { describe, expect, it } from 'vitest'
import { MistakeSplitSchema } from '../../shared/mistakes'
import { cropBox, fidelityFlags, normalizeDiagnosis, numericalAnswers, compareNumericalAnswers, poolDeficit, stripDocumentIdentity, mistakeMarkdown } from './mistakes'
import { markdownToNodes } from './markdown'

describe('错题来源、诊断与变式约束', () => {
  it('拒绝第21题，而不是截断后伪称拆分完整', () => {
    const q = { question: 'x² − 5x + 6 = 0', myAnswer: '', correctAnswer: '', solution: '', subject: 'math', regions: [] }
    expect(MistakeSplitSchema.safeParse({ questions: Array.from({ length: 21 }, () => q) }).success).toBe(false)
  })
  it('按0–1000 grounding外接框裁图，不读无效块或负索引', () => {
    const blocks = [{ label: 'text', box: [100, 200, 300, 400] as [number, number, number, number], text: '第一题' },
      { label: 'text', box: [200, 300, 600, 500] as [number, number, number, number], text: '第二行' }]
    expect(cropBox(blocks, [0, 1, 99, -1], 2000, 1000)).toEqual({ x: 200, y: 200, width: 1000, height: 300 })
    expect(cropBox(blocks, [99], 2000, 1000)).toBeNull()
    expect(cropBox([{ ...blocks[0], box: [0, 0, 1100, 100] }], [0], 2000, 1000)).toBeNull()
  })
  it('长OCR不能掩盖题干或学生答案中的编造', () => {
    expect(fidelityFlags('solve x² − 5x + 6 = 0', 'x = 6', 'solve x² − 5x + 6 = 0\nmy answer x = 6')).toEqual([])
    expect(fidelityFlags('计算宇宙年龄以及火星上的水量', '', '解方程x² − 5x + 6 = 0')).toContain('recognition-uncertain')
    expect(fidelityFlags('solve x² − 5x + 6 = 0', 'Mars is green', 'solve x² − 5x + 6 = 0\nx = 6')).toContain('recognition-uncertain')
  })
  it('没有我的答案必须unknown；引用不存在的步骤也不能成为诊断', () => {
    const d = { cause: 'calculation' as const, reason: '“5−6=1”是错误的运算。', evidence: '5−6=1', concepts: ['一元二次方程'] }
    expect(normalizeDiagnosis(d, '').cause).toBe('unknown')
    expect(normalizeDiagnosis(d, 'x=2').cause).toBe('unknown')
    expect(normalizeDiagnosis(d, '因为5−6=1，所以x=1').cause).toBe('calculation')
    expect(normalizeDiagnosis({ ...d, reason: '学生粗心了。' }, '5−6=1').cause).toBe('unknown')
    expect(normalizeDiagnosis({ ...d, evidence: '$5-6=1$', reason: '“\\(5-6=1\\)”这一步计算错误。' }, '$5-6=1$').cause).toBe('calculation')
    expect(normalizeDiagnosis({ ...d, evidence: '$5-6=2$', reason: '“5-6=2”这一步计算错误。' }, '$5-6=1$').cause).toBe('unknown')
  })
  it('独立比较实际答案的所有数值，不能只信模型的numericAnswer声明', () => {
    expect(numericalAnswers('x = 2, 3')).toEqual([2, 3])
    expect(numericalAnswers('$x=\\frac{1}{2}$')).toEqual([0.5])
    expect(compareNumericalAnswers('x=2,3', 'x=3,2')).toBe(true)
    expect(compareNumericalAnswers('x=2,3', 'x=2,4')).toBe(false)
    expect(compareNumericalAnswers('4 m/s', '4 kg')).toBe(false)
    expect(numericalAnswers('由牛顿第二定律求解')).toBeNull()
  })
  it('服务商答案的末尾句号不改变数值、单位和完整根集', () => {
    const candidate = '$x=4$ 或 $x=\\frac{1}{2}$。'
    expect(numericalAnswers(candidate)).toEqual([0.5, 4])
    expect(compareNumericalAnswers(candidate, 'x=1/2 或 x=4')).toBe(true)
    expect(compareNumericalAnswers(candidate, 'x=1/2 或 x=5')).toBe(false)
    expect(compareNumericalAnswers(candidate, 'x=4')).toBe(false)
    expect(numericalAnswers('\\(x=4\\) 或 \\(x=5\\)。')).toEqual([4, 5])
    expect(numericalAnswers('x=2.5。')).toEqual([2.5])
    expect(compareNumericalAnswers('4 m/s.', '4 m/s')).toBe(true)
    expect(compareNumericalAnswers('4 m/s。', '4 kg。')).toBe(false)
    expect(numericalAnswers('x=2。说明根取正值')).toBeNull()
    expect(numericalAnswers('x=2。。')).toBeNull()
    expect(numericalAnswers('x=process.exit()。')).toBeNull()
  })
  it('相同数值的单位声明不同仍拒绝，不用unit字段猜测数值', () => {
    expect(compareNumericalAnswers('8', '8', 'cm', 'mm')).toBe(false)
    expect(compareNumericalAnswers('8', '9', 'cm', 'cm')).toBe(false)
    expect(compareNumericalAnswers('面积取正值', '8', 'cm²', 'cm²')).toBe(false)
    expect(compareNumericalAnswers('x=2,3', 'x=2', 'm', 'm')).toBe(false)
  })
  it('答案正文的单位与结构声明冲突不能接纳', () => {
    expect(compareNumericalAnswers('8 cm', '8 cm', 'mm', 'cm')).toBe(false)
    expect(compareNumericalAnswers('8 cm', '8 cm', 'cm', 'mm')).toBe(false)
    expect(compareNumericalAnswers('8 cm', '8 mm', 'cm', 'cm')).toBe(false)
    expect(compareNumericalAnswers('8', '8 cm', '', 'cm')).toBe(false)
  })
  it('同单位的常见中英文别名与面积记号归一，不换算不同量级', () => {
    expect(compareNumericalAnswers('8 厘米', '8 cm', 'cm', '厘米')).toBe(true)
    expect(compareNumericalAnswers('8 cm', '8', 'centimetres', '厘米')).toBe(true)
    expect(compareNumericalAnswers('8 m²', '8 m^2', '平方米', 'm²')).toBe(true)
    expect(compareNumericalAnswers('8 kg', '8 千克', 'kilograms', 'kg')).toBe(true)
    expect(compareNumericalAnswers('8 m/s', '8 米/秒', 'metres/second', 'm/s')).toBe(true)
    expect(compareNumericalAnswers('8 cm²', '8 cm^2', '\\mathrm{cm}^{2}', '平方厘米')).toBe(true)
    expect(compareNumericalAnswers('8 cm', '8 mm', '厘米', '毫米')).toBe(false)
    expect(compareNumericalAnswers('8 cm', '0.08 m', '厘米', '米')).toBe(false)
  })
  it('SI符号大小写保留量级；仅全称别名不区分英文大小写', () => {
    expect(compareNumericalAnswers('8', '8', 'mW', 'MW')).toBe(false)
    expect(compareNumericalAnswers('8 mW', '8 MW')).toBe(false)
    expect(compareNumericalAnswers('8 mW', '8 mW', 'MW', 'mW')).toBe(false)
    expect(compareNumericalAnswers('8', '8 mW', 'mW', 'mW')).toBe(true)
    expect(compareNumericalAnswers('8 cm', '8 厘米', 'CENTIMETRES', '厘米')).toBe(true)
    expect(compareNumericalAnswers('8 N', '8 牛顿', 'Newtons', 'N')).toBe(true)
  })
  it('保持2道未用题；三次有误以后不补题', () => {
    expect(poolDeficit([{ usedAt: null, flagged: false }, { usedAt: 1, flagged: false }])).toBe(1)
    expect(poolDeficit([{ usedAt: null, flagged: false }, { usedAt: null, flagged: false }])).toBe(0)
    expect(poolDeficit(Array.from({ length: 3 }, () => ({ usedAt: null, flagged: true })))).toBe(0)
  })
  it('正负号、根号、分数和多根标签都进入数值比较，保留单位与完整根集', () => {
    expect(compareNumericalAnswers('$x=\\pm 2$', '$x_1=-2, x_2=2$')).toBe(true)
    expect(compareNumericalAnswers('$x_1=\\sqrt{4}$', 'x=2')).toBe(true)
    expect(compareNumericalAnswers('$x=\\pm\\frac{\\sqrt{4}}{2}$', 'x=-1,1')).toBe(true)
    expect(compareNumericalAnswers('x=±2', 'x=2')).toBe(false)
    expect(compareNumericalAnswers('2 m,3 kg', '2 m,3 m')).toBe(false)
    expect(numericalAnswers('x=process.exit()')).toBeNull()
    expect(numericalAnswers('x=1/0')).toBeNull()
    expect(compareNumericalAnswers('\\(x=2\\) 或 \\(x=3\\)', 'x=2,3')).toBe(true)
  })
  it('落地验证只归一编辑器默认属性；公式、链接、图片与错题身份不能丢失', () => {
    const expected = { type: 'cornellRow', attrs: { mistakeId: 'm1' }, content: [{ type: 'paragraph', content: [
      { type: 'text', text: '原图', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'jiwei://asset/a.png' } }] },
      { type: 'inlineMath', attrs: { latex: 'x=2' } }, { type: 'image', attrs: { src: 'jiwei://asset/a.png', alt: '题图' } }
    ] }] }
    const actual = structuredClone(expected)
    Object.assign(actual.attrs, { id: 'row1', origin: 'receipt' })
    Object.assign(actual.content[0].content[0].marks![0], { attrs: {} })
    Object.assign(actual.content[0].content[0].marks![1].attrs!, { target: '_blank', rel: 'noopener noreferrer nofollow', class: null })
    Object.assign(actual.content[0].content[2].attrs!, { title: null })
    expect(stripDocumentIdentity(actual)).toEqual(stripDocumentIdentity(expected))
    const different = structuredClone(actual)
    different.content[0].content[1].attrs!.latex = 'x=3'
    expect(stripDocumentIdentity(different)).not.toEqual(stripDocumentIdentity(expected))
    different.content[0].content[1].attrs!.latex = 'x=2'
    different.content[0].content[0].marks![1].attrs!.href = 'jiwei://asset/b.png'
    expect(stripDocumentIdentity(different)).not.toEqual(stripDocumentIdentity(expected))
  })
  it('服务商的常见LaTeX分隔符落入真实inlineMath/blockMath，不丢反斜杠', () => {
    const nodes = markdownToNodes(mistakeMarkdown('答案 \\(x=2\\)。\n\n\\[x^2-5x+6=(x-2)(x-3)\\]'))
    expect(nodes[0].content?.find((n) => n.type === 'inlineMath')?.attrs?.latex).toBe('x=2')
    expect(nodes.find((n) => n.type === 'blockMath')?.attrs?.latex).toBe('x^2-5x+6=(x-2)(x-3)')
  })
})
