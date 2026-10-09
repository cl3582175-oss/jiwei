import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  extractTables,
  htmlTableToMarkdown,
  isDegenerate,
  mergeRecognized,
  normalizeRecognized,
  pageLocator,
  splitRecognized,
  withCaptions,
  parseGrounding,
  groundedText
} from '../recognized'
import { classifyPage } from '../../../worker/pdfTriage'

// 夹具按 LightOnOCR-2-1B 的真实输出格式编写（HTML 表格、标题横幅行、合并单元格），内容为自拟
const fixture = (n: string): string => readFileSync(join(__dirname, 'fixtures', n), 'utf8')

describe('recognized: tables', () => {
  it('converts a plain HTML table to Markdown, skipping a one-cell banner row', () => {
    const md = normalizeRecognized(fixture('ocr-table.md'))
    const lines = md.split('\n')
    expect(lines[0]).toBe('表2-1。学习方法对长期记忆的影响')
    expect(md).toContain('| 方法类型 | 做法 | 投入 | 长期效果 |')
    expect(md).toContain('| 间隔重复 | 在快要遗忘时复习，间隔逐渐拉长 | 中 | 强 |')
    expect(md).not.toContain('<td>')
  })

  it('keeps compact HTML when cells are merged', () => {
    const md = normalizeRecognized(fixture('ocr-merged-cells.md'))
    expect(md).toContain('<th colspan="4">加工</th>')
    expect(md).not.toMatch(/>\s+</)
    expect(md).toContain('编码。把新信息与已有知识联系起来的过程')
  })

  it('extracts only captions and tables from a table page', () => {
    const t = extractTables(normalizeRecognized(fixture('ocr-table.md')) + '\n\n正文段落不需要。')
    expect(t.startsWith('表2-1。')).toBe(true)
    expect(t).not.toContain('正文段落')
  })

  it('keeps captions written as Markdown headings or bold', () => {
    const t = extractTables('## **Table 3-1. Study methods compared**\n\n正文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(t).toBe('Table 3-1. Study methods compared\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
  })

  it('adds the caption from the text layer when the model left it out', () => {
    expect(withCaptions('| a |\n| --- |\n| 1 |', 'Chapter 3\nTable 3-1. Study methods compared\nMethod Effort')).toBe(
      'Table 3-1. Study methods compared\n\n| a |\n| --- |\n| 1 |'
    )
    expect(withCaptions('表2-1。组织结构\n\n| a |', '表2-1。 组织结构对项目的影响')).toBe('表2-1。组织结构\n\n| a |')
  })

  it('escapes pipes inside cells', () => {
    expect(htmlTableToMarkdown('<table><tr><th>a|b</th><th>c</th></tr><tr><td>1</td><td>2</td></tr></table>')).toBe(
      '| a\\|b | c |\n| --- | --- |\n| 1 | 2 |'
    )
  })
})

describe('recognized: splitting and merging', () => {
  it('splits long Markdown tables by rows and repeats the header', () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| 第 ${i} 行 | ${'内容'.repeat(10)} |`)
    const parts = splitRecognized(['| 名称 | 说明 |', '| --- | --- |', ...rows].join('\n'), 600)
    expect(parts.length).toBeGreaterThan(2)
    for (const p of parts) expect(p.startsWith('| 名称 | 说明 |\n| --- | --- |')).toBe(true)
    expect(parts.join('\n')).toContain('第 79 行')
  })

  it('inserts recognized segments after the text of the same page, scans in page order', () => {
    const seg = (page: number, text: string) => ({ kind: 'page', locator: pageLocator(page), text })
    const merged = mergeRecognized(
      [seg(1, 'p1'), seg(2, 'p2a'), seg(2, 'p2b'), seg(4, 'p4'), { kind: 'ocr:table', locator: pageLocator(2), text: '旧的识别' }],
      [
        { page: 2, need: 'table', text: '| a |\n| --- |\n| 1 |' },
        { page: 3, need: 'scan', text: '扫描页全文' },
        { page: 4, need: 'figure', text: '三个部分围绕结果' }
      ]
    )
    expect(merged.map((s) => s.text)).toEqual(['p1', 'p2a', 'p2b', '| a |\n| --- |\n| 1 |', '扫描页全文', 'p4', '［图解］三个部分围绕结果'])
    expect(merged[4].kind).toBe('ocr:scan')
  })

  it('detects degenerate repetition', () => {
    expect(isDegenerate('@'.repeat(60))).toBe(true)
    expect(isDegenerate('项目'.repeat(30))).toBe(true)
    expect(isDegenerate(fixture('ocr-merged-cells.md'))).toBe(false)
  })
})

describe('pdf triage', () => {
  const page = (lines: string[], extra: Partial<{ imageCover: number; paths: number }> = {}) =>
    classifyPage({ chars: lines.join('').replace(/\s/g, '').length, lines, imageCover: 0, paths: 0, ...extra })
  const body = '项目是为创造独特的产品、服务或成果而进行的临时性工作，具有明确的开始和结束。'.repeat(3)

  it('finds scans, tables and figures by captions', () => {
    expect(page([''], { imageCover: 0.98 })).toBe('scan')
    expect(page(['表2-1。 组织结构对项目的影响', body])).toBe('table')
    expect(page([body, '图 3-3：关注价值'])).toBe('figure')
    expect(page(['Figure 4. Results', body])).toBe('figure')
    expect(page(['Table 2-1. Effects of organizational structure on projects', body], { imageCover: 0.6 })).toBe('table')
  })

  it('ignores references in body text, tables of contents and decorative backgrounds', () => {
    expect(page(['图1-2展示了一个示例项目组合，说明了组织各组件', body])).toBeNull()
    expect(page(['表 2-1 项目管理关注领域与绩效域映射 . . . . . . . . . 114'])).toBeNull()
    expect(page([body, body, body], { imageCover: 1 })).toBeNull()
    expect(page([body])).toBeNull()
  })
})

// LightOnOCR-3 grounding 输出（格式与模型实测一致，内容自拟）
const GROUNDED = `![title](80,60,920,110) 第三章 记忆
![image](107,140,895,520) 三层同心圆：外层为长期记忆，中层为工作记忆，内层为注意。
![caption](107,540,437,560) 图3-1 记忆系统
![text](80,600,920,660) 编码越深，之后越容易提取。
![text+](80,665,920,700) 睡眠有助于巩固。
![table](80,720,920,860)
<table><tr><th>方法</th><th>效果</th></tr><tr><td>重读</td><td>弱</td></tr></table>
![caption](80,870,500,890) 表3-1 学习方法对比
![page_number](890,953,917,972) 42`

describe('grounding output (LightOnOCR-3)', () => {
  it('parses blocks with boxes and merges continuations', () => {
    const b = parseGrounding(GROUNDED)
    expect(b.map((x) => x.label)).toEqual(['title', 'image', 'caption', 'text', 'table', 'caption', 'page_number'])
    expect(b[1].box).toEqual([107, 140, 895, 520])
    expect(b[3].text).toBe('编码越深，之后越容易提取。\n睡眠有助于巩固。')
    expect(b[4].text).toContain('<table>')
  })

  it('scan page: full content without page furniture, figure as ［图解］, table as Markdown', () => {
    const t = groundedText(parseGrounding(GROUNDED), 'scan')
    expect(t).toContain('## 第三章 记忆')
    expect(t).toContain('［图解］图3-1 记忆系统：三层同心圆')
    expect(t).toContain('| 方法 | 效果 |')
    expect(t).not.toContain('42')
  })

  it('table page keeps tables with captions; figure page keeps figure descriptions', () => {
    const blocks = parseGrounding(GROUNDED)
    expect(groundedText(blocks, 'table')).toBe('表3-1 学习方法对比\n\n| 方法 | 效果 |\n| --- | --- |\n| 重读 | 弱 |')
    expect(groundedText(blocks, 'figure')).toBe('图3-1 记忆系统：三层同心圆：外层为长期记忆，中层为工作记忆，内层为注意。')
  })
})
