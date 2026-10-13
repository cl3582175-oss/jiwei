import { describe, expect, it } from 'vitest'
import { buildPreQuery, webGate, type WebGate, type WebGateInput } from '../webGate'

const defaults: WebGateInput = {
  text: 'What is p-value',
  mode: 'auto',
  policy: 'tool',
  webAvailable: true,
  academicEnabled: true,
  explicitContext: false,
  coverage: 'enough',
  toolsReliable: true,
  cautious: false,
  now: Date.UTC(2026, 9, 13, 12)
}

interface GateCase {
  name: string
  input: Partial<WebGateInput>
  status: WebGate['status']
  offerTools: boolean
  preSearch: boolean
  timeSensitive: boolean
  explicitAsk: boolean
  coverage: WebGateInput['coverage']
}

const cases: GateCase[] = [
  {
    name: '#01 feynman purpose is not allowed',
    input: { policy: 'never' },
    status: 'not-allowed',
    offerTools: false,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#02 off wins over an explicit search request',
    input: { mode: 'off', text: '搜一下' },
    status: 'off',
    offerTools: false,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: true,
    coverage: 'enough'
  },
  {
    name: '#03 no web or academic backend is unconfigured',
    input: { webAvailable: false, academicEnabled: false },
    status: 'unconfigured',
    offerTools: false,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#04 selected content is kept in context',
    input: { explicitContext: true, text: '解释这段' },
    status: 'context',
    offerTools: false,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#05 explicit web request overrides selected content',
    input: { explicitContext: true, text: '网上怎么说' },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: true,
    coverage: 'enough'
  },
  {
    name: '#06 always overrides selected content and searches before answering',
    input: { explicitContext: true, mode: 'always' },
    status: 'available',
    offerTools: true,
    preSearch: true,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#07 academic backend alone offers tools without pre-search',
    input: { webAvailable: false },
    status: 'academic-only',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#08 enough knowledge without freshness offers tools without pre-search',
    input: {},
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#09 reliable tools handle a time-sensitive question themselves',
    input: { text: 'DeepSeek 现在怎么收费' },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: true,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#10 unreliable tools pre-search a time-sensitive question',
    input: { text: 'DeepSeek 现在怎么收费', toolsReliable: false },
    status: 'available',
    offerTools: true,
    preSearch: true,
    timeSensitive: true,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#11 unreliable tools pre-search when the knowledge base has no coverage',
    input: { coverage: 'none', toolsReliable: false },
    status: 'available',
    offerTools: true,
    preSearch: true,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'none'
  },
  {
    name: '#12 partial coverage without freshness does not trigger pre-search',
    input: { coverage: 'partial', toolsReliable: false },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'partial'
  },
  {
    name: '#13 cautious mode prevents even always pre-search',
    input: { mode: 'always', cautious: true },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#14 last year regulation is time-sensitive',
    input: { text: '2025 年的规定' },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: true,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#15 historical regulation alone is not time-sensitive',
    input: { text: '2019 年的规定' },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#16 English look-up request is explicit',
    input: { text: 'Look it up online' },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: true,
    coverage: 'enough'
  },
  {
    name: '#17 stable English knowledge is neither explicit nor time-sensitive',
    input: {},
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#18 specified note scope maps to explicit context',
    input: { explicitContext: true },
    status: 'context',
    offerTools: false,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  },
  {
    name: '#19 explicit search follow-up overrides inline context',
    input: { explicitContext: true, text: '再搜一下最新的' },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: true,
    explicitAsk: true,
    coverage: 'enough'
  },
  {
    name: '#20 workspace tool policy is available',
    input: { policy: 'tool' },
    status: 'available',
    offerTools: true,
    preSearch: false,
    timeSensitive: false,
    explicitAsk: false,
    coverage: 'enough'
  }
]

describe('webGate specification cases', () => {
  it.each(cases)('$name', ({ input, name: _name, ...expected }) => {
    expect(webGate({ ...defaults, ...input })).toEqual(expected)
  })
})

describe('webGate priority and trigger boundaries', () => {
  it.each(['never', 'pipeline'] as const)('rejects %s policy before off/configuration/context', (policy) => {
    expect(webGate({ ...defaults, policy, mode: 'off', webAvailable: false, academicEnabled: false, explicitContext: true }).status).toBe(
      'not-allowed'
    )
  })

  it('returns off before missing configuration and explicit context', () => {
    expect(webGate({ ...defaults, mode: 'off', webAvailable: false, academicEnabled: false, explicitContext: true }).status).toBe('off')
  })

  it('returns unconfigured before explicit context', () => {
    expect(webGate({ ...defaults, webAvailable: false, academicEnabled: false, explicitContext: true }).status).toBe('unconfigured')
  })

  it('returns context before academic-only', () => {
    expect(webGate({ ...defaults, webAvailable: false, explicitContext: true }).status).toBe('context')
  })

  it('never pre-searches an academic-only turn, even with always, no coverage and unreliable tools', () => {
    expect(
      webGate({ ...defaults, mode: 'always', webAvailable: false, toolsReliable: false, coverage: 'none', text: '搜一下最新论文' })
    ).toEqual({ status: 'academic-only', offerTools: true, preSearch: false, timeSensitive: true, explicitAsk: true, coverage: 'none' })
  })

  it('pre-searches an explicit request with unreliable tools despite enough coverage', () => {
    expect(webGate({ ...defaults, text: '帮我搜 p-value', toolsReliable: false }).preSearch).toBe(true)
  })

  it('cautious mode disables every auto pre-search trigger while preserving tools', () => {
    expect(webGate({ ...defaults, text: '搜一下最新版本', toolsReliable: false, cautious: true, coverage: 'none' })).toEqual({
      status: 'available',
      offerTools: true,
      preSearch: false,
      timeSensitive: true,
      explicitAsk: true,
      coverage: 'none'
    })
  })

  it('retains detection flags and coverage even when web access is off', () => {
    expect(webGate({ ...defaults, mode: 'off', text: '搜一下最新版本', coverage: 'partial' })).toEqual({
      status: 'off',
      offerTools: false,
      preSearch: false,
      timeSensitive: true,
      explicitAsk: true,
      coverage: 'partial'
    })
  })

  it('recognizes only the prescribed Chinese explicit-search phrases', () => {
    for (const text of [
      '搜一下',
      '搜一搜',
      '搜搜',
      '搜索一下',
      '帮我搜',
      '上网',
      '联网',
      '网上',
      '网络上',
      '在线查',
      '官网',
      '查一下最新',
      '查查最新'
    ])
      expect(webGate({ ...defaults, text }).explicitAsk, text).toBe(true)
    for (const text of ['搜索算法', '查资料', '帮忙找找', 'lookup', 'search the browser', 'offline'])
      expect(webGate({ ...defaults, text }).explicitAsk, text).toBe(false)
  })

  it('recognizes prescribed English search phrases case-insensitively with word boundaries', () => {
    for (const text of [
      'SEARCH THE WEB',
      'search online',
      'search internet',
      'look up',
      'look this up',
      'look that up',
      'google this',
      'on the internet',
      'online'
    ])
      expect(webGate({ ...defaults, text }).explicitAsk, text).toBe(true)
    for (const text of ['search websites', 'look upside down', 'google these', 'on the webbing', 'onliner'])
      expect(webGate({ ...defaults, text }).explicitAsk, text).toBe(false)
  })

  it('recognizes all prescribed freshness/topic signals and keeps English word boundaries', () => {
    for (const text of [
      '最新',
      '最近',
      '近期',
      '现在',
      '目前',
      '当前',
      '如今',
      '今年',
      '本月',
      '这个月',
      '本周',
      '这周',
      '今天',
      '昨天',
      '刚刚',
      '实时',
      '价格',
      '售价',
      '多少钱',
      '报价',
      '汇率',
      '股价',
      '版本',
      '发布',
      '上市',
      '政策',
      '新规',
      '规定',
      '通知',
      '新闻',
      '比分',
      '天气',
      '排名',
      'LATEST',
      'recent',
      'recently',
      'current',
      'currently',
      'nowadays',
      'today',
      'yesterday',
      'this week',
      'this month',
      'this year',
      'price',
      'pricing',
      'cost',
      'version',
      'release',
      'releases',
      'released',
      'policy',
      'regulation',
      'news',
      'score',
      'weather',
      'ranking'
    ])
      expect(webGate({ ...defaults, text }).timeSensitive, text).toBe(true)
    for (const text of ['now', 'regulations', 'versioning', 'newspaper', 'scoreboard'])
      expect(webGate({ ...defaults, text }).timeSensitive, text).toBe(false)
  })

  it('uses the injected year and retains current signals alongside a historical year', () => {
    for (const text of [
      '2025 年的材料',
      '2026',
      '2027',
      '2019 和 2025',
      '2019 年规定现在如何',
      '最新的 2019 年规定',
      'current 2019 policy'
    ])
      expect(webGate({ ...defaults, text }).timeSensitive, text).toBe(true)
    for (const text of ['2024 年材料', '2019 policy', '2019 年的价格'])
      expect(webGate({ ...defaults, text }).timeSensitive, text).toBe(false)
    expect(webGate({ ...defaults, text: '2025', now: Date.UTC(2027, 9, 13, 12) }).timeSensitive).toBe(false)
  })
})

describe('buildPreQuery', () => {
  it('removes every prescribed Chinese filler without leaving parts of longer phrases', () => {
    expect(buildPreQuery('请 帮我 麻烦 能不能 可不可以 一下 搜一下 搜索一下 搜索 查一下 查查 上网 联网 网上 告诉我 LLM 吗？')).toBe('LLM')
  })

  it('collapses whitespace and removes trailing particles and question marks', () => {
    expect(buildPreQuery('  请帮我搜索一下\t DeepSeek\n  最新版本 呢？？  ')).toBe('DeepSeek 最新版本')
    expect(buildPreQuery('请告诉我 p-value 吧??')).toBe('p-value')
  })

  it.each(['please', 'can you', 'could you', 'search for', 'look up', 'tell me'])('removes leading English phrase %s', (prefix) => {
    expect(buildPreQuery(prefix + ' p-value?')).toBe('p-value')
  })

  it('removes chained English prefixes case-insensitively', () => {
    expect(buildPreQuery('  PLEASE could\t you search for DeepSeek pricing?')).toBe('DeepSeek pricing')
  })

  it('preserves English filler phrases inside the question and non-prefix words', () => {
    expect(buildPreQuery('What does "tell me" mean?')).toBe('What does "tell me" mean')
    expect(buildPreQuery('pleasework pricing')).toBe('pleasework pricing')
  })

  it('preserves punctuation and particles that are not at the end', () => {
    expect(buildPreQuery('哪呢? 后面怎么理解？')).toBe('哪呢? 后面怎么理解')
  })

  it('truncates to 70 Unicode characters without splitting supplementary characters', () => {
    expect(buildPreQuery('甲'.repeat(69) + '🧠乙')).toBe('甲'.repeat(69) + '🧠')
    expect(buildPreQuery('🧠'.repeat(71))).toBe('🧠'.repeat(70))
  })

  it('prepends exactly the last 40 Unicode characters of the previous user message to a short result', () => {
    expect(buildPreQuery('请告诉我价格呢？', '丢弃'.repeat(10) + '甲'.repeat(39) + '🧠')).toBe('甲'.repeat(39) + '🧠 价格')
  })

  it('counts the six-character boundary as Unicode characters', () => {
    expect(buildPreQuery('🧠'.repeat(5), '上一条问题')).toBe('上一条问题 ' + '🧠'.repeat(5))
    expect(buildPreQuery('🧠'.repeat(6), '上一条问题')).toBe('🧠'.repeat(6))
  })

  it('normalizes whitespace after adding the previous message and keeps the complete query within 70 characters', () => {
    const query = buildPreQuery('那呢？', '之前的问题\n\t要怎么回答')
    expect(query).toBe('之前的问题 要怎么回答 那')
    expect(Array.from(query).length).toBeLessThanOrEqual(70)
    expect(Array.from(buildPreQuery('🧠'.repeat(5), '甲'.repeat(100))).length).toBe(46)
  })

  it('leaves a short result usable without a previous message and handles an empty result', () => {
    expect(buildPreQuery('请告诉我价格呢？')).toBe('价格')
    expect(buildPreQuery('请搜一下吗？')).toBe('')
    expect(buildPreQuery('请搜一下吗？', '上一条问题')).toBe('上一条问题')
  })
})
