import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchHit } from '@shared/types'
import type { BackendId } from '@shared/retrieval'
import type { ReadPage } from '../reader'
import {
  allocate,
  authorityOf,
  coverage,
  fresh,
  lexical,
  scoreKb,
  scoreWeb,
  selectPassages,
  TUNING,
  type ScoredKb,
  type ScoredWeb,
  type WebCandidate
} from '../scoring'

const fixture = vi.hoisted(() => ({
  trusted: [] as string[],
  lowTrust: [] as string[],
  ready: vi.fn(),
  embed: vi.fn()
}))
vi.mock('../../settings', () => ({
  getSettings: () => ({ retrieval: { trustedSites: fixture.trusted, lowTrustSites: fixture.lowTrust } })
}))
vi.mock('../../ai/embedding', () => ({ isReady: fixture.ready, embed: fixture.embed }))
vi.mock('../../ai/indexer', () => ({ annotationText: vi.fn(), vecBuffer: vi.fn() }))
vi.mock('../../../db', () => ({
  getDb: () => {
    throw new Error('Scoring must not read the application database')
  },
  getSqlite: () => {
    throw new Error('Scoring must not read the application database')
  }
}))

const NOW = Date.UTC(2026, 9, 13),
  DAY = 86_400_000
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  fixture.trusted = []
  fixture.lowTrust = []
  fixture.ready.mockReset().mockResolvedValue(false)
  fixture.embed.mockReset()
})
afterEach(() => vi.restoreAllMocks())

function kb(values: Partial<SearchHit & { sim?: number }> = {}): SearchHit & { sim?: number } {
  return {
    parentType: 'note',
    parentId: 'parent-1',
    ownerId: 'owner-1',
    title: 'Controlled note',
    text: 'Controlled knowledge',
    locator: null,
    score: 1,
    learnedAt: null,
    updatedAt: null,
    status: null,
    origin: 'user',
    ...values
  }
}
function web(values: Partial<WebCandidate> = {}): WebCandidate {
  return {
    pageId: 'page-1',
    url: 'https://example.org/article',
    title: 'Controlled article',
    text: 'Controlled passage',
    publishedAt: null,
    fetchedAt: NOW,
    ...values
  }
}
function scoredKb(id: string, score: number, values: Partial<SearchHit> = {}, fallback = false): ScoredKb {
  return { hit: kb({ parentId: id, ownerId: id, ...values }), score, fallback }
}
function scoredWeb(id: string, score: number, values: Partial<WebCandidate> = {}, fallback = false): ScoredWeb {
  return { hit: web({ pageId: id, url: `https://example.org/${id}`, ...values }), score, fallback }
}
function page(texts: string[]): ReadPage {
  let offset = 0
  const passages = texts.map((text, index) => {
    const start = offset
    offset += text.length + 2
    return { index, start, end: start + text.length, text, suspicious: index === 1 }
  })
  return {
    page: {
      id: 'page-1',
      url: 'https://reuters.com/article',
      title: 'Controlled page',
      siteName: 'Controlled fixture',
      publishedAt: NOW,
      fetchedAt: NOW,
      method: 'fetch',
      text: texts.join('\n\n')
    },
    passages
  }
}
function vectorScores(scores: number[]): void {
  fixture.ready.mockResolvedValue(true)
  fixture.embed.mockResolvedValueOnce([[1, 0]]).mockResolvedValueOnce(scores.map((value) => [value, Math.sqrt(1 - value * value)]))
}

describe('retrieval score tuning and coverage', () => {
  it('uses the exact calibration defaults', () => {
    expect(TUNING).toEqual({
      REL: 0.55,
      FLOOR: 0.35,
      SLOTS: 12,
      KB_MIN: 3,
      WEB_MIN: 3,
      PER_PAGE: 2,
      PER_PARENT: 3,
      HALF_LIFE_DAYS: 90,
      FRESH_MIN: 0.5,
      FRESH_UNKNOWN: 0.8
    })
  })
  it('returns none for an empty knowledge set', () => expect(coverage([])).toBe('none'))
  it('returns partial when all hits lack semantic similarity', () => expect(coverage([kb(), kb({ score: 2 })])).toBe('partial'))
  it('returns enough for two semantic hits at the inclusive REL threshold', () =>
    expect(coverage([kb({ sim: 0.55 }), kb({ sim: 0.8 })])).toBe('enough'))
  it('returns partial for exactly one semantic hit above REL', () =>
    expect(coverage([kb({ sim: 0.55 }), kb({ sim: 0.54 }), kb()])).toBe('partial'))
  it('returns none when existing semantic similarities are all below REL', () => expect(coverage([kb({ sim: 0.54 }), kb()])).toBe('none'))
})

describe('freshness coefficient', () => {
  it('is one for a query that is not time sensitive even with no date', () => {
    expect(fresh(null, false)).toBe(1)
    expect(fresh(NOW - 1000 * DAY, false)).toBe(1)
  })
  it('uses the unknown-date coefficient', () => expect(fresh(null, true)).toBe(0.8))
  it('uses the exact decay before the 90-day half-life', () => expect(fresh(NOW - 45 * DAY, true)).toBeCloseTo(Math.SQRT1_2))
  it('uses the floor at and after the half-life', () => {
    expect(fresh(NOW - 90 * DAY, true)).toBe(0.5)
    expect(fresh(NOW - 180 * DAY, true)).toBe(0.5)
  })
  it('keeps the specified future-date formula without an upper clamp', () => expect(fresh(NOW + 90 * DAY, true)).toBe(2))
})

describe('source authority', () => {
  it.each([
    'agency.gov',
    'agency.gov.cn',
    'university.edu',
    'university.edu.cn',
    'research.ac.cn',
    'research.ac.uk',
    'agency.mil',
    'who.int',
    'un.org',
    'europa.eu',
    'nature.com',
    'science.org',
    'cell.com',
    'thelancet.com',
    'nejm.org',
    'springer.com',
    'sciencedirect.com',
    'wiley.com',
    'ieee.org',
    'acm.org',
    'arxiv.org',
    'cnki.net',
    'doi.org'
  ])('gives authoritative domain %s a coefficient of 1.2', (domain) => expect(authorityOf(`https://${domain}/article`)).toBe(1.2))
  it.each([
    'wikipedia.org',
    'xinhuanet.com',
    'news.cn',
    'people.com.cn',
    'cctv.com',
    'thepaper.cn',
    'caixin.com',
    'reuters.com',
    'apnews.com',
    'bbc.com',
    'bbc.co.uk',
    'nytimes.com',
    'ft.com',
    'economist.com',
    'wsj.com',
    'bloomberg.com'
  ])('gives editorial domain %s a coefficient of 1', (domain) => expect(authorityOf(`https://${domain}/article`)).toBe(1))
  it.each([
    'medium.com',
    'substack.com',
    'blogspot.com',
    'wordpress.com',
    'jianshu.com',
    'csdn.net',
    'cnblogs.com',
    'juejin.cn',
    'toutiao.com',
    'baijiahao.baidu.com',
    'mp.weixin.qq.com',
    'zhuanlan.zhihu.com'
  ])('gives self-publishing domain %s a coefficient of 0.8', (domain) => expect(authorityOf(`https://${domain}/article`)).toBe(0.8))
  it.each(['https://www.sohu.com/a/123', 'https://news.163.com/dy/article/123'])('recognizes publisher path %s', (url) =>
    expect(authorityOf(url)).toBe(0.8)
  )
  it.each([
    'https://sohu.com/news/123',
    'https://163.com/news/123',
    'https://example.org/a/123',
    'https://sohu.com/a',
    'https://evil-sohu.com/a/123',
    'https://163.com.evil.test/dy/123'
  ])('does not extend publisher path rules to %s', (url) => expect(authorityOf(url)).toBe(0.9))
  it.each(['openalex', 'semanticscholar', 'arxiv'] as BackendId[])('gives academic backend %s a coefficient of 1.2', (backend) =>
    expect(authorityOf('https://example.org/paper', backend)).toBe(1.2)
  )
  it('applies low trust before user trust, academic metadata and built-in authority', () => {
    fixture.lowTrust = ['nature.com']
    fixture.trusted = ['nature.com']
    expect(authorityOf('https://research.nature.com/paper', 'openalex')).toBe(0.5)
  })
  it('applies user trust before built-in publishing rules', () => {
    fixture.trusted = ['medium.com']
    expect(authorityOf('https://author.medium.com/paper')).toBe(1.2)
  })
  it('matches user domain overrides on the exact host and subdomains only', () => {
    fixture.lowTrust = ['blocked.example']
    fixture.trusted = ['trusted.example']
    expect(authorityOf('https://www.blocked.example/article')).toBe(0.5)
    expect(authorityOf('https://sub.trusted.example/article')).toBe(1.2)
    expect(authorityOf('https://foo-blocked.example/article')).toBe(0.9)
    expect(authorityOf('https://trusted.example.evil.test/article')).toBe(0.9)
  })
  it('does not trust lookalike built-in host suffixes', () => {
    expect(authorityOf('https://foo-nature.com/article')).toBe(0.9)
    expect(authorityOf('https://nature.com.evil.test/article')).toBe(0.9)
    expect(authorityOf('https://fakeagencygov/article')).toBe(0.9)
    expect(authorityOf('https://WWW.News.Nature.COM/article')).toBe(1.2)
  })
  it('ignores empty custom domain entries', () => {
    fixture.trusted = ['', '   ']
    fixture.lowTrust = ['', '   ']
    expect(authorityOf('https://example.org/article')).toBe(0.9)
  })
  it('defaults an unclassified or invalid URL to 0.9', () => {
    expect(authorityOf('https://example.org/article', 'bocha')).toBe(0.9)
    expect(authorityOf('not a URL')).toBe(0.9)
  })
})

describe('lexical relevance fallback', () => {
  it('uses adjacent Han bigrams', () => expect(lexical('知识图谱', '知识检索')).toBeCloseTo(1 / 3))
  it('does not form Han bigrams across whitespace or English letters', () => {
    expect(lexical('知识 图谱', '知识检索图谱')).toBe(1)
    expect(lexical('知X识', '知识')).toBe(0)
  })
  it('uses lowercased English word sets and discards single-character words', () =>
    expect(lexical('ALPHA alpha BETA a I', 'beta ALPHA')).toBe(1))
  it('computes English overlap relative to the query set, not paragraph size', () =>
    expect(lexical('alpha beta gamma delta', 'alpha beta unrelated words')).toBe(0.5))
  it('splits punctuation at English word boundaries', () => expect(lexical('Alpha, beta; gamma', 'ALPHA BETA')).toBeCloseTo(2 / 3))
  it.each(['', 'a I', '知', '!?'])('returns zero for empty token set %s', (query) => expect(lexical(query, 'alpha 知识')).toBe(0))
})

describe('knowledge scoring', () => {
  it('reuses the existing status/origin weight and prefer multiplier for semantic hits', () => {
    const result = scoreKb([kb({ sim: 0.8, status: 'outdated', origin: 'ai', parentId: 'preferred' })], 'preferred')
    expect(result[0]?.score).toBeCloseTo(0.5984)
    expect(result[0]?.fallback).toBe(false)
  })
  it('reuses the existing recent-update boost', () => expect(scoreKb([kb({ sim: 0.5, updatedAt: NOW })])[0]?.score).toBeCloseTo(0.575))
  it('normalizes missing semantic scores by the largest RRF score before weight and prefer', () => {
    const result = scoreKb([kb({ score: 10, sim: 0.1 }), kb({ score: 5, status: 'disputed', parentId: 'preferred' })], 'preferred')
    expect(result[0]?.score).toBeCloseTo(0.1)
    expect(result[1]?.score).toBeCloseTo(0.68)
    expect(result.map((entry) => entry.fallback)).toEqual([false, true])
  })
  it('keeps a real zero similarity instead of replacing it with RRF', () => expect(scoreKb([kb({ sim: 0, score: 10 })])[0]?.score).toBe(0))
  it('handles zero RRF scores and an empty list without NaN', () => {
    expect(scoreKb([kb({ score: 0 })])[0]?.score).toBe(0)
    expect(scoreKb([])).toEqual([])
  })
  it('preserves hit order, references and original retrieval scores', () => {
    const low = kb({ ownerId: 'low', sim: 0.1, score: 3 }),
      high = kb({ ownerId: 'high', sim: 0.9, score: 2 })
    const result = scoreKb([low, high])
    expect(result.map((entry) => entry.hit.ownerId)).toEqual(['low', 'high'])
    expect(result[0]?.hit).toBe(low)
    expect(low.score).toBe(3)
    expect(high.score).toBe(2)
  })
})

describe('web scoring and controlled embedding boundary', () => {
  it('rechecks current privacy after query embedding and blocks document sending without lexical fallback', async () => {
    let allowed = true
    const denied = new Error('Controlled privacy denial')
    fixture.ready.mockResolvedValue(true)
    fixture.embed.mockImplementationOnce(async () => {
      allowed = false
      return [[1, 0]]
    })
    await expect(
      scoreWeb([web()], 'Controlled query', {
        timeSensitive: false,
        beforeSend: () => {
          if (!allowed) throw denied
        }
      })
    ).rejects.toBe(denied)
    expect(fixture.embed).toHaveBeenCalledTimes(1)
  })

  it('rejects current privacy denial even when embeddings are unavailable', async () => {
    const denied = new Error('Controlled privacy denial')
    await expect(
      scoreWeb([web()], 'Controlled query', {
        timeSensitive: false,
        beforeSend: () => {
          throw denied
        }
      })
    ).rejects.toBe(denied)
    expect(fixture.embed).not.toHaveBeenCalled()
  })

  it('calls query embedding once and document embedding once in a batch with titles, then applies dot/authority/fresh', async () => {
    fixture.ready.mockResolvedValue(true)
    fixture.embed.mockResolvedValueOnce([[0.6, 0.8]]).mockResolvedValueOnce([
      [0.8, 0.6],
      [1, 0]
    ])
    const results = await scoreWeb(
      [
        web({ url: 'https://nature.com/article', title: 'Title one', text: 'Passage one', publishedAt: NOW - 90 * DAY }),
        web({ title: 'Title two', text: 'Passage two', publishedAt: NOW })
      ],
      'Controlled query',
      { timeSensitive: true }
    )
    expect(results[0]?.score).toBeCloseTo(0.576)
    expect(results[1]?.score).toBeCloseTo(0.54)
    expect(results.map((entry) => entry.fallback)).toEqual([false, false])
    expect(fixture.ready).toHaveBeenCalledTimes(1)
    expect(fixture.embed).toHaveBeenCalledTimes(2)
    expect(fixture.embed).toHaveBeenNthCalledWith(1, ['Controlled query'], 'query')
    expect(fixture.embed).toHaveBeenNthCalledWith(2, ['Passage one', 'Passage two'], 'doc', ['Title one', 'Title two'])
  })
  it('uses lexical scoring when embeddings are not ready', async () => {
    const result = await scoreWeb([web({ text: 'alpha beta' })], 'alpha beta gamma delta', { timeSensitive: false })
    expect(result[0]?.score).toBe(0.45)
    expect(result[0]?.fallback).toBe(true)
    expect(fixture.embed).not.toHaveBeenCalled()
  })
  it.each(['readiness', 'query', 'documents'] as const)('uses lexical fallback after an embedding %s failure', async (stage) => {
    if (stage === 'readiness') fixture.ready.mockRejectedValue(new Error('Controlled readiness failure'))
    else {
      fixture.ready.mockResolvedValue(true)
      if (stage === 'query') fixture.embed.mockRejectedValue(new Error('Controlled query failure'))
      else fixture.embed.mockResolvedValueOnce([[1, 0]]).mockRejectedValueOnce(new Error('Controlled doc failure'))
    }
    const result = await scoreWeb([web({ text: 'alpha beta' })], 'alpha beta', { timeSensitive: false })
    expect(result[0]?.score).toBe(0.9)
    expect(result[0]?.fallback).toBe(true)
    expect(fixture.embed).toHaveBeenCalledTimes(stage === 'readiness' ? 0 : stage === 'query' ? 1 : 2)
  })
  it('does not use a partial or dimension-mismatched document batch as semantic evidence', async () => {
    fixture.ready.mockResolvedValue(true)
    fixture.embed.mockResolvedValueOnce([[1, 0]]).mockResolvedValueOnce([[1]])
    const result = await scoreWeb([web({ text: 'alpha beta' })], 'alpha beta', { timeSensitive: false })
    expect(result[0]?.score).toBe(0.9)
    expect(result[0]?.fallback).toBe(true)
  })
  it('does not call embeddings when there are no web candidates', async () => {
    expect(await scoreWeb([], 'Controlled query', { timeSensitive: true })).toEqual([])
    expect(fixture.ready).not.toHaveBeenCalled()
    expect(fixture.embed).not.toHaveBeenCalled()
  })
})

describe('context slot allocation', () => {
  it('reserves three qualifying entries for each side before filling by score', () => {
    const knowledge = Array.from({ length: 12 }, (_, i) => scoredKb(`k${i}`, 1 - i / 100)),
      webpages = [scoredWeb('w0', 0.4), scoredWeb('w1', 0.39), scoredWeb('w2', 0.38), scoredWeb('w3', 0.37)]
    const result = allocate(knowledge, webpages)
    expect(result.kb).toHaveLength(9)
    expect(result.web.map((entry) => entry.hit.pageId)).toEqual(['w0', 'w1', 'w2'])
  })
  it('allows one side to fill all slots when the other side is below its floor', () => {
    const knowledge = Array.from({ length: 12 }, (_, i) => scoredKb(`k${i}`, 0.8))
    expect(allocate(knowledge, [scoredWeb('low', 0.34)]).kb).toHaveLength(12)
    const webpages = Array.from({ length: 12 }, (_, i) => scoredWeb(`w${i}`, 0.8))
    expect(allocate([scoredKb('low', 0.34)], webpages).web).toHaveLength(12)
  })
  it('caps one knowledge parent at three and one webpage at two', () => {
    const result = allocate(
      [
        scoredKb('k0', 0.9, { parentId: 'same' }),
        scoredKb('k1', 0.8, { parentId: 'same' }),
        scoredKb('k2', 0.7, { parentId: 'same' }),
        scoredKb('k3', 0.6, { parentId: 'same' })
      ],
      [scoredWeb('same', 0.9), scoredWeb('same', 0.8), scoredWeb('same', 0.7)]
    )
    expect(result.kb.map((entry) => entry.hit.ownerId)).toEqual(['k0', 'k1', 'k2'])
    expect(result.web.map((entry) => entry.score)).toEqual([0.9, 0.8])
  })
  it('uses canonical URL keys when snippet candidates have no page ID', () => {
    const result = allocate(
      [],
      [
        scoredWeb('a', 0.9, { pageId: '', url: 'http://www.example.org/story/?utm_source=one' }),
        scoredWeb('b', 0.8, { pageId: '', url: 'https://example.org/story' }),
        scoredWeb('c', 0.7, { pageId: '', url: 'https://example.org/story?utm_source=two' }),
        scoredWeb('d', 0.6, { pageId: '', url: 'https://example.org/different' })
      ]
    )
    expect(result.web.map((entry) => entry.score)).toEqual([0.9, 0.8, 0.6])
  })
  it('uses 0.2 as the inclusive fallback floor without weakening semantic floor', () => {
    const result = allocate(
      [scoredKb('fallback', 0.2, {}, true), scoredKb('semantic', 0.2), scoredKb('low', 0.199, {}, true)],
      [scoredWeb('fallback', 0.2, {}, true), scoredWeb('semantic', 0.2), scoredWeb('low', 0.199, {}, true)]
    )
    expect(result.kb.map((entry) => entry.hit.parentId)).toEqual(['fallback'])
    expect(result.web.map((entry) => entry.hit.pageId)).toEqual(['fallback'])
  })
  it.each([0, 1, 2, 4, 5, 6, 7])('never exceeds the custom slot cap %s', (slots) => {
    const result = allocate(
      Array.from({ length: 10 }, (_, i) => scoredKb(`k${i}`, 0.9)),
      Array.from({ length: 10 }, (_, i) => scoredWeb(`w${i}`, 0.8)),
      slots
    )
    expect(result.kb.length + result.web.length).toBe(slots)
    if (slots === 4) {
      expect(result.kb).toHaveLength(2)
      expect(result.web).toHaveLength(2)
    }
  })
  it('does not mutate the input queues while sorting or applying limits', () => {
    const knowledge = [scoredKb('low', 0.4), scoredKb('high', 0.9)],
      webpages = [scoredWeb('low', 0.4), scoredWeb('high', 0.9)]
    const result = allocate(knowledge, webpages, 2)
    expect(knowledge.map((entry) => entry.score)).toEqual([0.4, 0.9])
    expect(webpages.map((entry) => entry.score)).toEqual([0.4, 0.9])
    expect(result.kb[0]?.score).toBe(0.9)
    expect(result.web[0]?.score).toBe(0.9)
  })
})

describe('reading passage selection', () => {
  it('selects highest qualifying relevance but restores original passage order', async () => {
    vectorScores([0.6, 0.9, 0.2, 0.8])
    const read = page(['zero', 'one', 'two', 'three'])
    const result = await selectPassages(read, 'Controlled query', { timeSensitive: false, k: 2 })
    expect(result.map((passage) => passage.index)).toEqual([1, 3])
    expect(result.map((passage) => passage.score)).toEqual([0.9, 0.8])
    expect(result.every((passage) => passage.fallback === false)).toBe(true)
    expect(result[0]).toMatchObject({ text: 'one', start: 6, end: 9, suspicious: true })
    expect(read.passages[1]).not.toHaveProperty('score')
  })
  it('uses the semantic floor inclusively', async () => {
    vectorScores([0.35, 0.34])
    expect(
      (await selectPassages(page(['one', 'two']), 'Controlled query', { timeSensitive: false })).map((passage) => passage.index)
    ).toEqual([0])
  })
  it('defaults to at most six qualifying passages', async () => {
    vectorScores([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])
    expect(await selectPassages(page(['0', '1', '2', '3', '4', '5', '6']), 'Controlled query', { timeSensitive: false })).toHaveLength(6)
  })
  it('returns the best three as low relevance when every semantic score is below the floor', async () => {
    vectorScores([0.1, 0.3, 0.2, 0.25, 0.29])
    const result = await selectPassages(page(['0', '1', '2', '3', '4']), 'Controlled query', { timeSensitive: false })
    expect(result.map((passage) => passage.index)).toEqual([1, 3, 4])
    expect(result.every((passage) => passage.fallback === true)).toBe(true)
  })
  it('keeps the low-relevance top-three fallback within the caller k limit', async () => {
    vectorScores([0.1, 0.3, 0.2, 0.25])
    expect(
      (await selectPassages(page(['0', '1', '2', '3']), 'Controlled query', { timeSensitive: false, k: 2 })).map((passage) => passage.index)
    ).toEqual([1, 3])
  })
  it('distinguishes lexical scoring from low-relevance fallback metadata', async () => {
    const result = await selectPassages(page(['alpha beta', 'gamma delta', 'unrelated']), 'alpha beta gamma delta epsilon zeta', {
      timeSensitive: false
    })
    expect(result.map((passage) => passage.index)).toEqual([0, 1])
    expect(result.map((passage) => passage.score)).toEqual([1 / 3, 1 / 3])
    expect(result.every((passage) => passage.fallback === false)).toBe(true)
  })
  it('marks top-three lexical selections as low relevance when none reaches 0.2', async () => {
    const result = await selectPassages(page(['aa', 'bb', 'cc', 'dd']), 'aa bb cc dd ee ff', { timeSensitive: false })
    expect(result.map((passage) => passage.index)).toEqual([0, 1, 2])
    expect(result.every((passage) => passage.fallback === true)).toBe(true)
  })
  it('does not call embedding for an empty page or zero passage limit', async () => {
    expect(await selectPassages(page([]), 'Controlled query', { timeSensitive: false })).toEqual([])
    expect(await selectPassages(page(['one']), 'Controlled query', { timeSensitive: false, k: 0 })).toEqual([])
    expect(fixture.embed).not.toHaveBeenCalled()
  })
})
