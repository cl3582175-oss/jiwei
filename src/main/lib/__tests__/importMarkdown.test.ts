import { describe, expect, it } from 'vitest'
import { importMarkdown, decodeImportText } from '../importMarkdown'
import { matchNote } from '../../services/importer/obsidian'

const text = (v: unknown): string => JSON.stringify(v)
describe('Markdown library conversion', () => {
  it('prefers frontmatter, preserves creation date and reports ignored properties', () => {
    const r = importMarkdown(
      '---\ntitle: 自写笔记\ntags: [记忆, a/b]\naliases: [别名]\ncreated: 2025-02-03\nunknown: x\n---\n# 原标题\n\n引子 #复习\n\n## 原理\n\n**正文**',
      '名字.md'
    )
    expect(r.title).toBe('自写笔记')
    expect(r.tags).toEqual(['记忆', 'a/b', '复习'])
    expect(r.aliases).toEqual(['别名'])
    expect(r.createdAt).toBe(Date.UTC(2025, 1, 3))
    expect(r.ignored).toEqual(['aliases', 'unknown'])
    expect(r.rows).toBe(2)
    expect(text(r.doc)).toContain('原标题')
    expect(text(r.doc)).toContain('原理')
  })
  it('consumes an H1 used as title, ignoring headings within code', () => {
    const r = importMarkdown('# 中文标题\n\n前言\n\n```md\n## 假标题\n```\n\n## 小节\n\n内容', 'fallback.md')
    expect(r.title).toBe('中文标题')
    expect(r.rows).toBe(2)
    expect(text(r.doc)).not.toContain('中文标题')
    expect(text(r.doc)).toContain('## 假标题')
  })
  it('handles empty, frontmatter-only, BOM and long unheaded paragraphs', () => {
    expect(importMarkdown('', '空.md').rows).toBe(1)
    expect(importMarkdown('---\ntags: [only]\n---', '属性.md').title).toBe('属性')
    expect(importMarkdown('\uFEFF# BOM', 'a.md').title).toBe('BOM')
    const r = importMarkdown(Array.from({ length: 8 }, (_, i) => `${i}${'字'.repeat(900)}`).join('\n\n'), '长.md')
    expect(r.rows).toBeGreaterThan(1)
    for (let i = 0; i < 8; i++) expect(text(r.doc)).toContain(`${i}${'字'.repeat(900)}`)
  })
  it('keeps math, tables, regular code and converts Mermaid to a real diagram', () => {
    const r = importMarkdown(
      '$x_1$\n\n$$x^2$$\n\n|甲|乙|\n|---|---|\n|1|2|\n\n```ts\nx()\n```\n\n```mermaid\nflowchart LR\n A-->B\n```',
      '内容.md'
    )
    for (const kind of ['inlineMath', 'blockMath', 'table', 'codeBlock', 'embed']) expect(text(r.doc)).toContain(`"type":"${kind}"`)
    expect(Object.values(r.embeds)[0]).toMatchObject({ kind: 'diagram', data: { code: 'flowchart LR\n A-->B' } })
  })
  it('collects links and attachments, preserves callouts and task markers without actions', () => {
    const r = importMarkdown(
      '[[目录/笔记#小节|别名]] [去读](other.md) ![[图.png]] ![](附件/图.png) ![[文件.pdf]]\n\n> [!note] 提示\n> 内容\n\n- [ ] 甲\n- [x] 乙\n\n`#假 [[不是链接]]`\n\n[外部](https://example.org) <b>纯文本</b>',
      'a.md'
    )
    expect(r.refs.map((x) => x.kind)).toEqual(['note', 'note', 'image', 'image', 'attachment'])
    expect(r.refs[0]).toMatchObject({ target: '目录/笔记', anchor: '小节', label: '别名', wiki: true })
    expect(r.tasks).toBe(2)
    expect(r.tags).toEqual([])
    expect(text(r.doc)).toContain('☐')
    expect(text(r.doc)).toContain('☑')
    expect(text(r.doc)).toContain('bold')
    expect(text(r.doc)).toContain('https://example.org')
    expect(text(r.doc)).not.toContain('<b>')
  })
  it('never treats tags or wiki syntax in code or math as content references', () => {
    const r = importMarkdown('```txt\n#假 [[不存在]]\n```\n\n`#无` $x#y$ #真 #a/b', 'a.md')
    expect(r.tags).toEqual(['真', 'a/b'])
    expect(r.refs).toEqual([])
  })
  it('recognizes a tag immediately after Chinese punctuation without treating URL fragments as tags', () => {
    expect(importMarkdown('正文。#复习 [网页](https://example.org/#anchor) 字母#不算', 'a.md').tags).toEqual(['复习'])
  })
  it('decodes UTF8 BOM and GBK and rejects invalid input', () => {
    expect(decodeImportText(Buffer.from('\uFEFF中文')).text).toBe('中文')
    expect(decodeImportText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toEqual({ text: '中文', encoding: 'GBK' })
    expect(() => decodeImportText(Buffer.from([0xff, 0xff]))).toThrow()
  })
  it('preserves reference-style links and HTTP autolinks', () => {
    const r = importMarkdown('[页面][p] <https://example.org>\n\n[p]: other.md', 'a.md')
    expect(r.refs).toContainEqual({ kind: 'note', target: 'other.md', label: '页面', wiki: false })
    expect(text(r.doc)).toContain('https://example.org')
  })
  it('splits a single oversized prose paragraph without losing its content', () => {
    const r = importMarkdown('字'.repeat(9500), '长段.md')
    expect(r.rows).toBeGreaterThan(1)
    expect((text(r.doc).match(/字/g) ?? []).length).toBe(9500)
  })
})
describe('Obsidian shortest unique path matching', () => {
  const entries = [
    { path: '甲/同名.md', title: '同名', aliases: ['甲别名'] },
    { path: '乙/同名.md', title: '同名', aliases: [] },
    { path: '独立.md', title: '独立', aliases: ['唯一别名'] }
  ]
  it('prefers the current folder, then exact/suffix paths, then unique alias', () => {
    expect(matchNote('同名', '甲/来源.md', entries)?.path).toBe('甲/同名.md')
    expect(matchNote('乙/同名', '甲/来源.md', entries)?.path).toBe('乙/同名.md')
    expect(matchNote('唯一别名', '甲/来源.md', entries)?.path).toBe('独立.md')
    expect(matchNote('../独立.md', '甲/来源.md', entries, false)?.path).toBe('独立.md')
  })
  it('does not guess ambiguous, missing or escaping targets', () => {
    expect(matchNote('同名', '根.md', entries)).toBeNull()
    expect(matchNote('不存在', '根.md', entries)).toBeNull()
    expect(matchNote('../../独立.md', '甲/来源.md', entries, false)).toBeNull()
  })
})
