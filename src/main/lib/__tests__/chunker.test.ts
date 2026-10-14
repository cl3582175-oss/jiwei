import { describe, expect, it } from 'vitest'
import { chunkBlocks, EMBED_MAX_CHARS } from '../chunker'
import type { DocBlock } from '../docBlocks'

const para = (text: string, page?: number): DocBlock => ({ type: 'paragraph', text, ...(page ? { page } : {}) })
const heading = (text: string, level: number): DocBlock => ({ type: 'heading', text, level })
const chunk = (blocks: DocBlock[], lang?: 'zh' | 'en') =>
  chunkBlocks(blocks, { lang, locatorOf: (b) => ({ value: b.page ? `page=${b.page}` : `block=${blocks.indexOf(b)}` }) })

describe('结构切分保留定位、路径、原文与上限', () => {
  it('连续标题只入路径，不独立成段，遇到新标题不合并', () => {
    const blocks = [
      heading('第一章 条件', 1),
      heading('2.1 测试', 2),
      para('合成记录。'.repeat(70)),
      heading('2.2 交付', 2),
      para('结果校验。'.repeat(70))
    ]
    const result = chunk(blocks)
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.heading)).toEqual(['第一章 条件 › 2.1 测试', '第一章 条件 › 2.2 交付'])
    expect(result[0].locator).toEqual({ value: 'block=2' })
  })
  it('编/部分文档中的章和节下移一级', () => {
    expect(
      chunk([heading('第一编 总则', 1), heading('第一章 条件', 1), heading('第一节 试验', 2), para('明确的检查结果。')])[0].heading
    ).toBe('第一编 总则 › 第一章 条件 › 第一节 试验')
  })
  it('同节积累至目标，短尾并入前段，保留跨页范围', () => {
    const result = chunk([para('运行记录。'.repeat(70), 1), para('补充的短记录。', 2)])
    expect(result).toHaveLength(1)
    expect(result[0].text).toContain('补充的短记录。')
    expect(result[0].locator).toEqual({ value: 'page=1', pageEnd: 2 })
  })
  it('长段落在句末断开且不丢字', () => {
    const text = '本轮核对记录齐全，后续可继续执行。'.repeat(130)
    const result = chunk([para(text)])
    expect(result.length).toBeGreaterThan(2)
    expect(result.map((s) => s.text).join('')).toBe(text)
    expect(result.every((s) => s.text.length <= EMBED_MAX_CHARS.zh && /[。！？；.!?;]$/.test(s.text))).toBe(true)
  })
  it('短片段不跨新标题，也不跨表格合并', () => {
    const result = chunk([heading('第一章 甲', 1), para('甲段'), heading('第二章 乙', 1), para('乙段')])
    expect(result.map((s) => s.text)).toEqual(['甲段', '乙段'])
  })
  it('Markdown 表格每组重复表头和表标题，所有行都有出处', () => {
    const rows = Array.from({ length: 21 }, (_, i) => [`行${i}`, `描述${i}：${'检验记录'.repeat(15)}`])
    const result = chunk([{ type: 'table', caption: '表1 合成指标', header: ['项目', '说明'], rows }])
    expect(result.length).toBeGreaterThan(1)
    expect(result.every((s) => s.kind === 'table' && s.text.startsWith('表1 合成指标\n| 项目 | 说明 |\n| --- | --- |'))).toBe(true)
    for (const [id, text] of rows) expect(result.some((s) => s.text.includes(`| ${id} | ${text} |`))).toBe(true)
  })
  it('小版式表格转键值，与同节普通正文合并', () => {
    const result = chunk([para('交付说明。'.repeat(30)), { type: 'table', header: ['签字', '日期'], rows: [['甲方', '2046-01-01']] }])
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('paragraph')
    expect(result[0].text).toContain('签字：甲方')
    expect(result[0].text).toContain('日期：2046-01-01')
  })
  it('合并单元格长表重复第一行并保持 HTML 完整', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `<tr><td rowspan="2">项${i}</td><td>${'内容'.repeat(130)}</td></tr>`)
    const html = `<table><tr><th>项目</th><th>内容</th></tr>${rows.join('')}</table>`
    const result = chunk([{ type: 'table', header: null, rows: [], html }], 'zh')
    expect(result.length).toBeGreaterThan(1)
    expect(
      result.every(
        (s) =>
          s.text.startsWith('<table>') &&
          s.text.endsWith('</table>') &&
          s.text.includes('<th>项目</th>') &&
          s.text.length <= EMBED_MAX_CHARS.zh
      )
    ).toBe(true)
    for (const row of rows) expect(result.some((s) => s.text.includes(row))).toBe(true)
  })
  it('代码超长按行切分，保留每一行且遵守硬上限', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `const item${i} = "${'x'.repeat(40)}";`)
    const result = chunk([{ type: 'code', text: lines.join('\n') }], 'en')
    expect(result.every((s) => s.kind === 'code' && s.text.length <= EMBED_MAX_CHARS.en)).toBe(true)
    expect(result.map((s) => s.text).join('\n')).toBe(lines.join('\n'))
  })
  it('汉字比例决定中文/西文目标，显式语言可覆盖', () => {
    expect(chunk([para('x'.repeat(900))])).toHaveLength(1)
    expect(chunk([para('x'.repeat(900))], 'zh')).toHaveLength(2)
    expect(chunk([para('合成'.repeat(250) + 'x'.repeat(500))]).length).toBeGreaterThan(1)
  })
  it('路径最多四级且最多120字符，不变更输入', () => {
    const blocks: DocBlock[] = [1, 2, 3, 4, 5].map((level) => heading(`${level} ${'长标题'.repeat(15)}`, level))
    blocks.push(para('正文'))
    const before = JSON.stringify(blocks)
    const result = chunk(blocks)
    expect(result[0].heading.length).toBeLessThanOrEqual(120)
    expect(result[0].heading.split(' › ').length).toBeLessThanOrEqual(4)
    expect(JSON.stringify(blocks)).toBe(before)
  })
  it('超长表头也遵守模型上限，不截丢文字', () => {
    const header = '独立字段说明'.repeat(450)
    const result = chunk([{ type: 'table', header: [header], rows: [['原始数据标记A']] }], 'zh')
    expect(result.every((s) => s.text.length <= EMBED_MAX_CHARS.zh)).toBe(true)
    expect(result.map((s) => s.text).join('')).toContain(header)
    expect(result.some((s) => s.text.includes('原始数据标记A'))).toBe(true)
  })
  it('超长单个表格行切成有效续行，原文没有消失', () => {
    const value = '逐项核对原始记录。'.repeat(400)
    const result = chunk([{ type: 'table', header: ['项目', '说明'], rows: [['独立项甲', value]] }], 'zh')
    expect(result.every((s) => s.text.length <= EMBED_MAX_CHARS.zh && /^\| 独立项甲 \| .* \|$/m.test(s.text))).toBe(true)
    const cells = result.flatMap((s) =>
      s.text
        .split('\n')
        .slice(2)
        .map((line) => line.slice(2, -2).split(' | ')[1])
    )
    expect(cells.join('')).toBe(value)
  })
  it('超长单行代码不截丢', () => {
    const text = 'x'.repeat(15000)
    const result = chunk([{ type: 'code', text }], 'en')
    expect(result.every((s) => s.text.length <= EMBED_MAX_CHARS.en)).toBe(true)
    expect(result.map((s) => s.text).join('')).toBe(text)
  })
})
