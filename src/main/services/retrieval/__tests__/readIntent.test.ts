import { describe, expect, it } from 'vitest'
import { directReadIntent } from '../readIntent'

const url = 'https://example.org/article'
describe('current-user page reading intent', () => {
  it.each([url, `请总结 ${url}`, `Read ${url}`])('recognizes an ordinary local reading request: %s', (text) => {
    expect(directReadIntent(text)).toMatchObject({ urls: [url], requested: true })
    expect(directReadIntent(text).cloudUrl).toBeUndefined()
  })
  it.each([`用 DeepSeek 读取这个公开网址：${url}`, `Please use DeepSeek to read ${url}`, `请用云端读取 ${url}`])(
    'grants exactly one explicitly chosen cloud URL: %s',
    (text) => {
      expect(directReadIntent(text).cloudUrl).toBe(url)
    }
  )
  it.each([
    `不要用 DeepSeek 读取 ${url}`,
    `DeepSeek 是什么？请本地阅读 ${url}`,
    `云端会有什么风险？请总结 ${url}`,
    `示例：“用 DeepSeek 读取 ${url}”`,
    `> 用 DeepSeek 读取 ${url}`,
    `\`用 DeepSeek 读取 ${url}\``,
    `\`\`\`\n用 DeepSeek 读取 ${url}\n\`\`\``,
    `用 DeepSeek 读取 ${url} 和 https://example.org/other`
  ])('does not derive cloud consent from ambiguous, quoted or negated text: %s', (text) => {
    expect(directReadIntent(text).cloudUrl).toBeUndefined()
  })
  it('keeps balanced parentheses that belong to a page URL', () => {
    const target = 'https://en.wikipedia.org/wiki/Function_(mathematics)'
    expect(directReadIntent(`Read (${target}).`).urls).toEqual([target])
  })
})
