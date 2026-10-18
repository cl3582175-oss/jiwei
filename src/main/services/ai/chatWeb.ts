import type { BackendId } from '@shared/retrieval'
import { retrievalZh, retrievalEn } from '../../../renderer/src/features/retrieval/messages'
import type { AgentStep, Citation, SearchHit } from '@shared/types'
import { currentRun } from '../agent/context'
import { requestApproval } from '../agent/approval'
import { newId } from '../../lib/ids'
import { getSettings } from '../settings'
import { urlKey } from '../retrieval/backends/normalize'
import { assertPageReadable, getPage } from '../retrieval/reader'
import { PagePolicyError } from '../retrieval/pagePolicy'
import { allocate, scoreKb, scoreWeb, type WebCandidate } from '../retrieval/scoring'
import { buildPreQuery } from '../retrieval/webGate'
import { filterCloudHits } from './recordingPrivacy'
import { stepLabel, type AgentSession } from './tools'
import { passageHit, readForSession, searchForSession, snippetHit } from './webTools'

interface PreSearchOptions {
  kbHits: SearchHit[]
  prevUserText?: string
  signal?: AbortSignal
  pushStep: (step: AgentStep) => void
}
export interface PreSearchResult {
  kbHits: SearchHit[]
  webHits: SearchHit[]
  failed: boolean
}
interface CandidateEntry {
  hit: SearchHit
  candidate: WebCandidate
  assertReadable?: () => void
}

function charsRange(locator: string | null): { start: number; end: number } | null {
  const match = locator?.match(/^chars=(\d+)-(\d+)$/)
  if (!match) return null
  const start = Number(match[1]),
    end = Number(match[2])
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start ? { start, end } : null
}
function candidateEntry(hit: SearchHit, backend: BackendId, assertReadable?: () => void): CandidateEntry {
  const range = charsRange(hit.locator)
  return {
    hit,
    assertReadable,
    candidate: {
      pageId: hit.parentId,
      url: hit.url!,
      title: hit.title,
      text: hit.text,
      site: hit.site,
      publishedAt: hit.learnedAt,
      fetchedAt: hit.updatedAt ?? Date.now(),
      ...(range ?? {}),
      snippetOnly: hit.snippetOnly,
      suspicious: hit.suspicious,
      backend,
      meta: hit.meta
    }
  }
}
function taint(hits: SearchHit[]): void {
  const run = currentRun()
  if (hits.length && run) run.state.tainted = true
}

/** Application-owned reading works even when the model cannot call tools or Search is unconfigured. */
export async function runPreReadForTurn(session: AgentSession, urls: string[], options: PreSearchOptions): Promise<PreSearchResult> {
  const messages = session.zh ? retrievalZh : retrievalEn
  const webHits: SearchHit[] = []
  let failed = false
  for (const [index, url] of [...new Set(urls)].slice(0, 2).entries()) {
    if (options.signal?.aborted) break
    const step = { id: 'direct-read-' + index, tool: 'read_url', ...stepLabel('read_url', { url }, session.zh) }
    if (getSettings().retrieval.cautious) {
      const approval = { id: newId(), title: step.label, detail: url, level: 'read' as const, tainted: false }
      options.pushStep({ ...step, status: 'waiting', approval: { ...approval, state: 'pending' } })
      const outcome = await requestApproval(
        { ...approval, messageId: session.messageId, conversationId: session.conversationId, tool: 'read_url' },
        options.signal
      )
      options.pushStep({ ...step, status: outcome === 'allowed' ? 'running' : 'denied', approval: { ...approval, state: outcome } })
      if (outcome !== 'allowed') continue
    } else options.pushStep({ ...step, status: 'running' })
    try {
      const response = await readForSession(session, url, session.web.userText, options.signal)
      response.assertReadable()
      webHits.push(...response.selected.map((passage) => passageHit(response.read, passage)))
      options.pushStep({
        ...step,
        status: 'done',
        detail: messages.passageSelection
          .replace('{{total}}', String(response.read.passages.length))
          .replace('{{k}}', String(response.selected.length))
      })
    } catch {
      failed = true
      options.pushStep({ ...step, status: 'error', detail: messages.proactiveReadFailed })
    }
  }
  const allowedPages = new Set(session.web.pageGuards?.keys())
  const current = filterCloudHits(webHits, session.conversationId, allowedPages)
    .filter((hit) => {
      try {
        session.web.pageGuards?.get(hit.parentId)?.()
        return true
      } catch {
        return false
      }
    })
    .slice(0, 6)
  taint(current)
  return { kbHits: filterCloudHits(options.kbHits, session.conversationId), webHits: current, failed }
}

export async function runPreSearchForTurn(session: AgentSession, options: PreSearchOptions): Promise<PreSearchResult> {
  const messages = session.zh ? retrievalZh : retrievalEn
  if (session.web.gate.status !== 'available' || getSettings().retrieval.cautious) throw new Error(messages.proactiveUnavailable)

  const query = buildPreQuery(session.web.userText, options.prevUserText)
  const searchStep = { id: 'pre-search', tool: 'web_search', ...stepLabel('web_search', { query }, session.zh) }
  try {
    // 次数、白名单及网络策略由共享操作维护，主动路径不重复预留次数。
    const searched = await searchForSession(session, { query }, options.signal)
    options.pushStep({ ...searchStep, status: 'done', detail: searched.backendLabel })
    const results = [...searched.results].sort((a, b) => a.rank - b.rank)
    const readResults = new Map<(typeof results)[number], Awaited<ReturnType<typeof readForSession>>>()
    for (const [index, result] of results.slice(0, 2).entries()) {
      // 跳过前两条中的已收藏或当前不可读结果；不从后续名次补位增加读取。
      if (getSettings().retrieval.cautious || options.signal?.aborted) break
      if (result.savedSource || !filterCloudHits([snippetHit(result)]).length) continue
      const readStep = { id: 'pre-read-' + index, tool: 'read_url', ...stepLabel('read_url', { url: result.url }, session.zh) }
      try {
        const response = await readForSession(session, result.url, session.web.userText, options.signal)
        readResults.set(result, response)
        const total = response.read.passages.length,
          k = response.selected.length
        const detail = messages.passageSelection.replace('{{total}}', String(total)).replace('{{k}}', String(k))
        const fallback = response.selected.some((passage) => passage.fallback)
        options.pushStep({
          ...readStep,
          status: 'done',
          detail: detail + (fallback ? '\n' + messages.passageLowRelevance : '')
        })
      } catch {
        // 未知错误可能包含查询、Key或路径；步骤仅给出固定的安全文案，继续处理其他结果。
        options.pushStep({
          ...readStep,
          status: 'error',
          detail: messages.proactiveReadFailed
        })
      }
    }
    const entries: CandidateEntry[] = []
    for (const result of results) {
      const snippet = snippetHit(result),
        read = readResults.get(result)
      if (read?.selected.length) {
        for (const passage of read.selected)
          entries.push(candidateEntry({ ...passageHit(read.read, passage), meta: snippet.meta }, result.backend, read.assertReadable))
      } else entries.push(candidateEntry(snippet, result.backend))
    }
    // 云端评分前先检查隐私；评分可能等待模型，返回消息候选前再重查一次。
    const readable = new Set(filterCloudHits(entries.map((entry) => entry.hit)))
    const currentEntries = entries.filter((entry) => readable.has(entry.hit))
    const hitByCandidate = new Map(currentEntries.map((entry) => [entry.candidate, entry.hit]))
    const assertEntryReadable = (entry: CandidateEntry): void => {
      // 缓存清理不能丢掉原始/最终URL检查；同一轮次的工具读取也保留在session map中。
      entry.assertReadable?.()
      const pageGuard = session.web.pageGuards?.get(entry.hit.parentId)
      if (pageGuard && pageGuard !== entry.assertReadable) pageGuard()
    }
    const scored = await scoreWeb(
      currentEntries.map((entry) => entry.candidate),
      session.web.userText,
      {
        timeSensitive: session.web.gate.timeSensitive,
        beforeSend: () => {
          // 向量查询与每批正文发送之间也可能等待；复用当前规则，不能只在评分函数外检查。
          if (options.signal?.aborted) throw new Error('canceled')
          for (const entry of currentEntries) assertEntryReadable(entry)
          if (filterCloudHits(currentEntries.map((entry) => entry.hit)).length !== currentEntries.length)
            throw new PagePolicyError('excluded')
        }
      }
    )
    // 评分后的隐私检查必须先于分配，否则被禁用网页仍会消耗知识库名额。
    if (options.signal?.aborted) throw new Error('canceled')
    const currentAfterScoring = currentEntries.filter((entry) => {
      try {
        assertEntryReadable(entry)
        return true
      } catch {
        return false
      }
    })
    const stillReadable = new Set(filterCloudHits(currentAfterScoring.map((entry) => entry.hit)))
    const currentScores = scored.filter((entry) => stillReadable.has(hitByCandidate.get(entry.hit)!))
    const allocated = allocate(scoreKb(filterCloudHits(options.kbHits), session.preferSource), currentScores)
    const kbHits = filterCloudHits(allocated.kb.map((entry) => entry.hit))
    const webHits = filterCloudHits(allocated.web.map((entry) => ({ ...hitByCandidate.get(entry.hit)!, score: entry.score })))
    taint(webHits)
    return { kbHits, webHits, failed: false }
  } catch {
    options.pushStep({
      ...searchStep,
      status: 'error',
      detail: messages.proactiveSearchFailed
    })
    // 整体搜索失败不能用空网页集合裁剪原检索结果；仅重查当前隐私。
    return { kbHits: filterCloudHits(options.kbHits), webHits: [], failed: true }
  }
}

export function previousWebHits(session: AgentSession, previousCitations: Citation[]): SearchHit[] {
  const candidates: SearchHit[] = previousCitations
    .filter((citation) => citation.parentType === 'web' && !citation.webOrigin)
    .map(({ n: _n, snippet, ...citation }) => ({
      ...citation,
      text: snippet,
      score: 1,
      via: 'web'
    }))
  // 先过滤再计最多六条，已禁用的早期引用不能挤掉后面的可用引用。
  const readable = filterCloudHits(candidates),
    hits: SearchHit[] = []
  for (const candidate of readable) {
    let hit = { ...candidate, locator: null as string | null }
    try {
      if (candidate.parentId) assertPageReadable(candidate.parentId)
      if (candidate.parentId && getPage(candidate.parentId)?.webOrigin) continue
      const range = charsRange(candidate.locator)
      if (range && candidate.parentId && !candidate.parentId.startsWith('tmp-')) {
        // 安全失败丢弃整条；只有不存在的快照或无效定位才可回退到旧 snippet。
        const page = getPage(candidate.parentId)
        if (page && range.end <= page.text.length) hit = { ...candidate, text: page.text.slice(range.start, range.end) }
      }
    } catch {
      continue
    }
    if (!hit.text.trim()) continue
    hits.push(hit)
    if (hits.length === 6) break
  }
  const current = filterCloudHits(hits)
  for (const hit of current) {
    const key = hit.url ? urlKey(hit.url) : null
    if (key) session.web.allowedUrls.add(key)
  }
  taint(current)
  return current
}
