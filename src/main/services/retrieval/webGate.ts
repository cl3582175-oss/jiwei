import type { WebMode } from '@shared/retrieval'
import type { WebPolicy } from './policy'

export interface WebGateInput {
  text: string
  mode: WebMode
  policy: WebPolicy
  webAvailable: boolean
  academicEnabled: boolean
  explicitContext: boolean
  coverage: 'enough' | 'partial' | 'none'
  toolsReliable: boolean
  cautious: boolean
  now: number
}

export interface WebGate {
  status: 'available' | 'academic-only' | 'off' | 'unconfigured' | 'context' | 'not-allowed'
  offerTools: boolean
  preSearch: boolean
  timeSensitive: boolean
  explicitAsk: boolean
  coverage: WebGateInput['coverage']
}

const EXPLICIT_ASK_ZH = /(搜一下|搜一搜|搜搜|搜索一下|帮我搜|上网|联网|网上|网络上|在线查|官网|查一下最新|查查最新)/
const EXPLICIT_ASK_EN =
  /\b(search (the )?(web|online|internet)|look (it |this |that )?up|google (it|this|that)|on the (web|internet)|online)\b/i
const TIME_SENSITIVE_ZH =
  /(最新|最近|近期|现在|目前|当前|如今|今年|本月|这个月|本周|这周|今天|昨天|刚刚|实时|价格|售价|多少钱|报价|汇率|股价|版本|发布|上市|政策|新规|规定|通知|新闻|比分|天气|排名)/
const TIME_SENSITIVE_EN =
  /\b(latest|recent(ly)?|current(ly)?|nowadays|today|yesterday|this (week|month|year)|price|pricing|cost|version|release[sd]?|policy|regulation|news|score|weather|ranking)\b/i
const CURRENT_TIME_ZH = /(最新|最近|近期|现在|目前|当前|如今|今年|本月|这个月|本周|这周|今天|昨天|刚刚|实时)/
const CURRENT_TIME_EN = /\b(latest|recent(ly)?|current(ly)?|nowadays|today|yesterday|this (week|month|year))\b/i

function needsCurrentInfo(text: string, now: number): boolean {
  const years = [...text.matchAll(/20\d\d/g)].map(([year]) => Number(year))
  const currentYear = new Date(now).getFullYear()
  if (years.some((year) => year >= currentYear - 1)) return true
  // 规格的历史年份用例优先：旧年的规定或价格不会单独触发时效需求，另有“最新”等信号时仍触发。
  if (years.length > 0 && !CURRENT_TIME_ZH.test(text) && !CURRENT_TIME_EN.test(text)) return false
  return TIME_SENSITIVE_ZH.test(text) || TIME_SENSITIVE_EN.test(text)
}

export function webGate(input: WebGateInput): WebGate {
  const result: WebGate = {
    status: 'not-allowed',
    offerTools: false,
    preSearch: false,
    timeSensitive: needsCurrentInfo(input.text, input.now),
    explicitAsk: EXPLICIT_ASK_ZH.test(input.text) || EXPLICIT_ASK_EN.test(input.text),
    coverage: input.coverage
  }

  if (input.policy !== 'tool') return result
  if (input.mode === 'off') return { ...result, status: 'off' }
  if (!input.webAvailable && !input.academicEnabled) return { ...result, status: 'unconfigured' }
  if (input.explicitContext && !result.explicitAsk && input.mode !== 'always') return { ...result, status: 'context' }
  if (!input.webAvailable && input.academicEnabled) return { ...result, status: 'academic-only', offerTools: true }
  return {
    ...result,
    status: 'available',
    offerTools: true,
    preSearch:
      !input.cautious &&
      (input.mode === 'always' || (!input.toolsReliable && (result.explicitAsk || result.timeSensitive || input.coverage === 'none')))
  }
}

const CHINESE_FILLERS = /(搜索一下|搜一下|查一下|可不可以|能不能|告诉我|帮我|麻烦|一下|搜索|查查|上网|联网|网上|请)/g
const ENGLISH_PREFIX = /^(?:(?:please|can\s+you|could\s+you|search\s+for|look\s+up|tell\s+me)\b\s*)+/i

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function buildPreQuery(text: string, prevUserText?: string): string {
  const cleaned = normalizeSpaces(
    text
      .replace(CHINESE_FILLERS, '')
      .trim()
      .replace(ENGLISH_PREFIX, '')
      .replace(/[吗呢吧?？]+\s*$/u, '')
  )
  // 按 Unicode 码点计字，避免拆开补充平面字符；续接后也保留同一查询长度上限。
  const characters = Array.from(cleaned).slice(0, 70)
  if (characters.length < 6 && prevUserText) {
    const previous = Array.from(prevUserText).slice(-40).join('')
    return Array.from(normalizeSpaces(`${previous} ${characters.join('')}`))
      .slice(0, 70)
      .join('')
  }
  return characters.join('')
}
