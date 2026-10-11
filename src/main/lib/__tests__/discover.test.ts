import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseFeed, normalizeFeed } from '../feedParser'
import { choosePicks, feedbackAllowed } from '../pickSelection'

const fixture = (name: string) => readFileSync(resolve('e2e/fixtures/feeds', name), 'utf8')
describe('发现订阅解析', () => {
  it('解析 RSS 的编码、作者、日期、音频与去重 URL', () => {
    const p = parseFeed(fixture('rss.xml'), 'https://example.org/rss')
    expect(p.title).toBe('学习订阅')
    expect(p.items[0]).toMatchObject({
      title: '练习 & 推理',
      author: '作者',
      summary: '解释条件',
      url: 'https://example.org/lesson',
      audioUrl: 'https://example.org/audio.mp3'
    })
    expect(p.items[0].publishedAt).toBe(Date.UTC(2026, 9, 9, 8))
  })
  it('解析 Atom / arXiv 和 YouTube 命名空间', () => {
    const arxiv = parseFeed(fixture('arxiv.xml'), 'https://rss.arxiv.org/rss/cs.AI')
    expect(arxiv.items[0]).toMatchObject({
      url: 'https://arxiv.org/abs/2601.00001',
      pdfUrl: 'https://arxiv.org/pdf/2601.00001',
      author: '示例研究者'
    })
    const youtube = parseFeed(fixture('youtube.xml'), 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890123456789012')
    expect(youtube.items[0]).toMatchObject({ title: '论证练习', summary: '一段讲解', url: 'https://www.youtube.com/watch?v=example' })
  })
  it('识别分类/频道并拒绝实体扩展与非网络链接', () => {
    expect(normalizeFeed('cs.AI')).toMatchObject({ kind: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.AI' })
    expect(normalizeFeed('https://www.youtube.com/channel/UC1234567890123456789012').kind).toBe('youtube')
    expect(() => parseFeed('<!DOCTYPE rss [<!ENTITY x "test">]><rss/>', 'https://example.org')).toThrow()
    expect(
      parseFeed('<rss><channel><item><title>X</title><link>javascript:alert(1)</link></item></channel></rss>', 'https://example.org').items
    ).toEqual([])
  })
})
describe('精选约束', () => {
  it('旧反馈不能再次发送已设为私有的知识库内容', () => {
    expect(feedbackAllowed('jiwei://note/private', new Set(['note:allowed']))).toBe(false)
    expect(feedbackAllowed('jiwei://note/allowed', new Set(['note:allowed']))).toBe(true)
    expect(feedbackAllowed('https://example.org/lesson', new Set())).toBe(true)
  })
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    url: `https://${i < 6 ? 'a' : 'b' + i}.org/${i}`,
    score: {
      relevance: 5,
      novelty: 5,
      credibility: 5,
      depth: 5 - i / 10,
      minutes: 15,
      reason: '补足论证方向',
      gap: '条件推理',
      related: [],
      goalIds: ['exam'],
      diverse: i === 11,
      news: i === 0
    }
  }))
  it('上限、同源、跨领域与 exam 新闻限制同时满足', () => {
    const selected = choosePicks(items, 5, new Set(['exam']))
    expect(selected).toHaveLength(5)
    expect(selected.some((p) => p.score.diverse)).toBe(true)
    expect(selected.some((p) => p.score.news)).toBe(false)
    expect(selected.filter((p) => new URL(p.url).hostname === 'a.org').length).toBeLessThanOrEqual(2)
  })
  it('低相关与零名额不能靠多样性入选', () => {
    expect(choosePicks(items, 0, new Set())).toEqual([])
    expect(choosePicks([{ ...items[11], score: { ...items[11].score, relevance: 0 } }], 5, new Set())).toEqual([])
  })
})
