import type { DocJSON, DocNode, ProposalOp } from '../../shared/types'
import type { Mistake, MistakeDiagnosis, MistakeFlag, MistakeVariant } from '../../shared/mistakes'
import type { ScanBlock } from '../../shared/scanText'
import { bigramOverlap } from './lensEvidence'
import { markdownToNodes } from './markdown'

export function cropBox(blocks: ScanBlock[], regions: number[], width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null
  const boxes = [...new Set(regions)].flatMap((i) => {
    const b = Number.isInteger(i) && i >= 0 ? blocks[i]?.box : undefined
    return b && b.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000) && b[2] > b[0] && b[3] > b[1] ? [b] : []
  })
  if (!boxes.length) return null
  const left = Math.floor(Math.min(...boxes.map((b) => b[0])) * width / 1000)
  const top = Math.floor(Math.min(...boxes.map((b) => b[1])) * height / 1000)
  const right = Math.min(width, Math.ceil(Math.max(...boxes.map((b) => b[2])) * width / 1000))
  const bottom = Math.min(height, Math.ceil(Math.max(...boxes.map((b) => b[3])) * height / 1000))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 题干和学生步骤分别作分母，避免题干正确时掩盖编造的学生答案。 */
export function fidelityFlags(question: string, myAnswer: string, evidence: string): MistakeFlag[] {
  if (!evidence.trim()) return ['recognition-uncertain']
  return [question, myAnswer].some((text) => text.trim() && bigramOverlap(text, evidence) < 0.55) ? ['recognition-uncertain'] : []
}
// 公式展示分隔符和等价的印刷符号不构成步骤差异；数值、运算符和字词保留。
const clean = (s: string): string => s.normalize('NFKC').replace(/\$|\\[()[\]]|\\[,;!]/g, '').replace(/\\pm/g, '±').replace(/[−–]/g, '-').replace(/\s+/g, '').toLowerCase()
export function normalizeDiagnosis(diagnosis: MistakeDiagnosis, myAnswer: string): MistakeDiagnosis {
  if (!myAnswer.trim()) return { ...diagnosis, cause: 'unknown', reason: '', evidence: '' }
  const evidence = clean(diagnosis.evidence)
  const valid = !!myAnswer.trim() && evidence.length >= 2 && clean(myAnswer).includes(evidence) && clean(diagnosis.reason).includes(evidence)
  return valid || diagnosis.cause === 'unknown' ? diagnosis : { ...diagnosis, cause: 'unknown', reason: '', evidence: '' }
}

const UNIT_ALIASES = new Map(Object.entries({
  米: 'm', metre: 'm', metres: 'm', meter: 'm', meters: 'm',
  厘米: 'cm', centimetre: 'cm', centimetres: 'cm', centimeter: 'cm', centimeters: 'cm',
  毫米: 'mm', millimetre: 'mm', millimetres: 'mm', millimeter: 'mm', millimeters: 'mm',
  千米: 'km', 公里: 'km', kilometre: 'km', kilometres: 'km', kilometer: 'km', kilometers: 'km',
  千克: 'kg', 公斤: 'kg', kilogram: 'kg', kilograms: 'kg', 克: 'g', gram: 'g', grams: 'g',
  秒: 's', second: 's', seconds: 's', sec: 's', 分钟: 'min', minute: 'min', minutes: 'min', 小时: 'h', hour: 'h', hours: 'h',
  牛顿: 'N', newton: 'N', newtons: 'N', 弧度: 'rad', radian: 'rad', radians: 'rad', 度: '°', degree: '°', degrees: '°',
  平方米: 'm^2', 平方厘米: 'cm^2', 平方毫米: 'mm^2', 平方千米: 'km^2',
  立方米: 'm^3', 立方厘米: 'cm^3', 立方毫米: 'mm^3'
}))
/** 全称别名归一；SI符号大小写保留量级，不换算或推断数值。 */
function normalizedUnit(raw: string): string | null {
  let unit = raw.normalize('NFKC').replace(/\$|\\[()[\]]/g, '').replace(/\\(?:mathrm|text)\{([^{}]*)\}/g, '$1')
    .replace(/\\[,;! ]/g, '').replace(/\^\{([+-]?\d+)\}/g, '^$1').replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/\s/g, '')
  if (unit && !/^[\p{L}%°][\p{L}\p{N}/*^%°-]*$/u.test(unit)) return null
  unit = unit.replace(/[\p{L}%°]+/gu, (name) => {
    const power = /^(square|cubic)(.+)$/i.exec(name)
    const base = power ? UNIT_ALIASES.get(power[2].toLowerCase()) ?? (['m', 'cm', 'mm', 'km'].includes(power[2]) ? power[2] : null) : null
    return base ? `${base}^${power![1].toLowerCase() === 'square' ? 2 : 3}` : UNIT_ALIASES.get(name.toLowerCase()) ?? name
  })
  return unit.replace(/(^|[/*])(mm|cm|km|m|s)([23])(?=$|[/*])/g, '$1$2^$3')
}

/** 安全的数值表达式语法；只接受运算符、有限数值和 sqrt，不执行模型文本。 */
function scalarExpression(expression: string): { value: number; unit: string } | null {
  const tokens: string[] = []
  let offset = 0
  while (offset < expression.length) {
    const space = /^\s*/.exec(expression.slice(offset))![0].length
    offset += space
    const token = /^(?:sqrt|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[+\-*/^()])/i.exec(expression.slice(offset))?.[0]
    if (!token) break
    tokens.push(token); offset += token.length
    if (tokens.length > 256) return null
  }
  const unit = expression.slice(offset).trim()
  if (unit && !/^[\p{L}%°][\p{L}\p{N}/·^\s%°−-]*$/u.test(unit)) return null
  let at = 0
  const factor = (): number => {
    let result: number
    const token = tokens[at++]
    if (token === '+') result = factor()
    else if (token === '-') result = -factor()
    else if (token === '(' || token?.toLowerCase() === 'sqrt') {
      if (token !== '(' && tokens[at++] !== '(') return NaN
      result = sum()
      if (tokens[at++] !== ')') return NaN
      if (token !== '(') result = Math.sqrt(result)
    } else result = token && /\d/.test(token) ? Number(token) : NaN
    if (tokens[at] === '^') { at++; result = result ** factor() }
    return result
  }
  const product = (): number => {
    let result = factor()
    while (tokens[at] === '*' || tokens[at] === '/') {
      const op = tokens[at++], right = factor()
      result = op === '*' ? result * right : result / right
    }
    return result
  }
  const sum = (): number => {
    let result = product()
    while (tokens[at] === '+' || tokens[at] === '-') {
      const op = tokens[at++], right = product()
      result = op === '+' ? result + right : result - right
    }
    return result
  }
  const value = sum()
  const canonicalUnit = normalizedUnit(unit)
  return at === tokens.length && Number.isFinite(value) && canonicalUnit !== null ? { value, unit: canonicalUnit } : null
}
/** 只解析最终答案，保留每个根与单位；解析文字或不支持的符号不作猜测。 */
function finalValues(answer: string): { value: number; unit: string }[] | null {
  // 只去掉一个终止句号；数值小数点、单位、根集和句中说明均继续按原语法验证。
  let s = answer.normalize('NFKC').trim().replace(/\$|\\[()[\]]/g, '').replace(/[。.]\s*$/, '').replace(/\\(?:left|right|quad|qquad|,|;|!| )/g, '')
    .replace(/\\(?:mathrm|text)\{([^{}]*)\}/g, '$1').replace(/\\pm/g, '±').replace(/[−–]/g, '-').replace(/[×·]/g, '*')
    .replace(/(?:答案|answer|[a-zA-Z](?:_\{?\d+\}?|\w*)?)\s*[:：=]\s*/gi, '')
    .replace(/\b(?:or|and)\b|或/g, ',')
  // 逐层转换嵌套的常见 LaTeX 根号/分数，剩余未知 LaTeX 将拒绝。
  for (let step = 0; step < 8; step++) {
    const prior = s
    s = s.replace(/\\sqrt\{([^{}]+)\}/g, 'sqrt($1)').replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '(($1)/($2))')
    if (s === prior) break
  }
  s = s.replace(/√\s*(\d+(?:\.\d+)?)/g, 'sqrt($1)')
  const list = s.split(/[,，;；]/).map((p) => p.trim()).filter(Boolean), out: { value: number; unit: string }[] = []
  if (!list.length) return null
  for (const p of list) {
    if ((p.match(/±/g)?.length ?? 0) > 1) return null
    const expressions = p.includes('±') ? [p.replace('±', '+'), p.replace('±', '-')] : [p]
    for (const expression of expressions) {
      const scalar = scalarExpression(expression)
      if (!scalar) return null
      out.push(scalar)
    }
  }
  return out.sort((a, b) => a.value - b.value || a.unit.localeCompare(b.unit))
}
export function numericalAnswers(answer: string): number[] | null { return finalValues(answer)?.map((n) => n.value) ?? null }
export function compareNumericalAnswers(a: string, b: string, aUnit = '', bUnit = ''): boolean {
  const valuesWithUnit = (answer: string, declaration: string): ReturnType<typeof finalValues> => {
    const values = finalValues(answer), unit = normalizedUnit(declaration)
    if (!values || unit === null || values.some((n) => n.unit && unit && n.unit !== unit)) return null
    return values.map((n) => ({ ...n, unit: n.unit || unit }))
  }
  const left = valuesWithUnit(a, aUnit), right = valuesWithUnit(b, bUnit)
  return !!left && !!right && left.length === right.length && left.every((n, i) => n.unit === right[i].unit && Math.abs(n.value - right[i].value) <= 1e-6 * Math.max(1, Math.abs(n.value), Math.abs(right[i].value)))
}
export function poolDeficit(variants: Pick<MistakeVariant, 'usedAt' | 'flagged'>[]): number {
  if (variants.filter((v) => v.flagged).length >= 3) return 0
  return Math.max(0, 2 - variants.filter((v) => !v.flagged && v.usedAt === null).length)
}

export const SUBJECT_NAMES = { math: ['数学', 'Mathematics'], physics: ['物理', 'Physics'], chemistry: ['化学', 'Chemistry'], english: ['英语', 'English'], other: ['其他', 'Other'] } as const
export const CAUSE_NAMES = { concept: ['概念不清', 'Concept'], calculation: ['计算失误', 'Calculation'], reading: ['审题错误', 'Reading'], method: ['方法不会', 'Method'], careless: ['粗心', 'Carelessness'], unknown: ['无法判断', 'Unknown'] } as const
export function mistakeAnswer(m: Pick<Mistake, 'correctAnswer' | 'solution' | 'myAnswer' | 'cause' | 'causeReason' | 'concepts' | 'sourceRef' | 'originalImageUrl'> & Partial<Pick<Mistake, 'answerOrigin' | 'verified'>>, zh: boolean): string {
  const parts = [
    m.answerOrigin === 'ai' && !m.verified && `**${zh ? 'AI 解答，待核对' : 'AI answer · unverified'}**`,
    m.correctAnswer && `**${zh ? '正确答案' : 'Correct answer'}**\n\n${m.correctAnswer}`,
    m.solution && `**${zh ? '解析' : 'Solution'}**\n\n${m.solution}`,
    m.myAnswer && `**${zh ? '我的答案' : 'My answer'}：**\n\n${m.myAnswer}`,
    `**${zh ? '错因' : 'Cause'}：** ${CAUSE_NAMES[m.cause][zh ? 0 : 1]}${m.causeReason ? ` · ${m.causeReason}` : ''}`,
    m.concepts.length && `${zh ? '知识点' : 'Concepts'}：${m.concepts.join('、')}`
  ].filter(Boolean) as string[]
  if (m.originalImageUrl) parts.push(`[${zh ? '原图' : 'Original image'}](${m.originalImageUrl})`)
  let source = m.sourceRef
  try { source = (JSON.parse(source ?? '') as { url?: string }).url ?? source } catch { /* 普通网址和本地来源身份保持原样 */ }
  if (source && /^(?:https?:\/\/|jiwei:\/\/(?:source|inbox)\/)/i.test(source)) parts.push(`[${zh ? '来源' : 'Source'}](${source.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`)
  return parts.join('\n\n')
}
export function mistakeOp(m: Mistake, zh: boolean): ProposalOp {
  const cue = markdownToNodes(mistakeMarkdown(m.question))
  if (m.imageUrl) cue.push({ type: 'image', attrs: { src: m.imageUrl, alt: zh ? '题图' : 'Question image' } })
  return { op: 'insert_row', afterRowId: null, mistakeId: m.id, cue, body: markdownToNodes(mistakeMarkdown(mistakeAnswer(m, zh))) }
}
/** 来源字段保留原文；落地时把常见LaTeX分隔符交给既有Markdown数学解析。 */
export function mistakeMarkdown(text: string): string {
  return text.replace(/\\\(([\s\S]*?)\\\)/g, (_, latex: string) => `$${latex}$`).replace(/\\\[([\s\S]*?)\\\]/g, (_, latex: string) => `\n\n$$\n${latex.trim()}\n$$\n\n`)
}
export function stripDocumentIdentity(n: DocNode): unknown {
  const attrs = { ...n.attrs }
  delete attrs.id
  delete attrs.origin
  for (const key of Object.keys(attrs)) if (attrs[key] === null || attrs[key] === undefined) delete attrs[key]
  const marks = n.marks?.map((mark) => {
    const markAttrs = { ...mark.attrs }
    for (const key of Object.keys(markAttrs)) if (markAttrs[key] === null || markAttrs[key] === undefined) delete markAttrs[key]
    // Tiptap 补入默认 HTML 属性；href 与用户设置的非默认属性仍必须完全一致。
    if (mark.type === 'link') {
      if (markAttrs.target === '_blank') delete markAttrs.target
      if (markAttrs.rel === 'noopener noreferrer nofollow') delete markAttrs.rel
    }
    return { type: mark.type, ...(Object.keys(markAttrs).length ? { attrs: markAttrs } : {}) }
  })
  return { type: n.type, ...(Object.keys(attrs).length ? { attrs } : {}), ...(n.text ? { text: n.text } : {}), ...(marks?.length ? { marks } : {}), ...(n.content?.length ? { content: n.content.map(stripDocumentIdentity) } : {}) }
}
export function rowForMistake(doc: DocJSON, id: string): DocNode | undefined {
  return doc.content?.find((n) => n.type === 'cornellRow' && n.attrs?.mistakeId === id)
}
