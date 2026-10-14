import { describe, expect, it } from 'vitest'
import { htmlBlocks } from './htmlBlocks'
import { chunkBlocks } from '../main/lib/chunker'
describe('HTML document blocks', () => {
  it('excludes hidden and script descendants inside visible paragraphs and tables', () => {
    const b = htmlBlocks(
      '<p>可见<span hidden>隐藏干扰</span><script>不应收录</script>正文。</p><table><tr><th>字段</th></tr><tr><td>值<span aria-hidden="true">秘密</span></td></tr></table>'
    )
    expect(b).toEqual([
      { type: 'paragraph', text: '可见正文。' },
      { type: 'table', header: ['字段'], rows: [['值']] }
    ])
  })
  it('keeps order, numbered headings, list lines and preformatted code', () => {
    const b = htmlBlocks('<h1>知识</h1><p>2.3验证</p><p>⼈需要证据。</p><ol><li>第一项</li><li>第二项</li></ol><pre>x  =  2\n  y</pre>')
    expect(b.map((a) => a.type)).toEqual(['heading', 'heading', 'paragraph', 'paragraph', 'code'])
    expect(b[3]).toMatchObject({ text: '- 第一项\n- 第二项' })
    expect(b[4]).toMatchObject({ text: 'x  =  2\n  y' })
    const chunks = chunkBlocks(b, { locatorOf: (a) => ({ value: `block=${b.indexOf(a)}` }) })
    expect(chunks[0].heading).toBe('知识 › 2.3验证')
    expect(chunks[0].text).toContain('人需要证据')
  })
  it('extracts captions and simple tables, skipping empty rows', () => {
    const b = htmlBlocks(
      '<p>表1 测试</p><table><tr><th>项目</th><th>值</th></tr><tr><td></td><td> </td></tr><tr><td>甲</td><td>2</td></tr></table>'
    )
    expect(b).toEqual([{ type: 'table', caption: '表1 测试', header: ['项目', '值'], rows: [['甲', '2']] }])
  })
  it('flattens nested tables once and preserves spans in safe compact HTML', () => {
    const b = htmlBlocks(
      '<table class="x"><tr><th colspan="12">项目</th></tr><tr><td onclick="bad()">外层<table><tr><th>名称</th><th>数量</th></tr><tr><td>部件</td><td>3</td></tr></table>后文</td></tr></table>'
    )
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ type: 'table' })
    if (b[0].type !== 'table') throw new Error('not a table')
    expect(b[0].html).toContain('colspan="12"')
    expect(b[0].html).not.toContain('onclick')
    expect(b[0].rows[0][0]).toContain('名称: 部件; 数量: 3')
    expect(b[0].html?.match(/<table>/g)).toHaveLength(1)
    expect(b[0].rows[0][0]).toContain('后文')
  })
  it('preserves repeated paragraphs and inline formula text, and ignores hidden/script content', () => {
    const b = htmlBlocks('<section><p>α² ≤ 0.05</p><p>α² ≤ 0.05</p><p hidden>隐藏</p><script>秘密</script></section>')
    expect(b).toEqual([
      { type: 'paragraph', text: 'α² ≤ 0.05' },
      { type: 'paragraph', text: 'α² ≤ 0.05' }
    ])
  })
})
