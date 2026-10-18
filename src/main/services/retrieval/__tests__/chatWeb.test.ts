import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { AgentStep, Citation, SearchHit } from '@shared/types'
import { RETRIEVAL_DEFAULTS, type WebResult } from '@shared/retrieval'
import type { DB } from '../../../db'
import type { AgentSession } from '../../ai/tools'
import type { Passage, ReadPage } from '../reader'
import * as schema from '../../../db/knowledgeSchema'

const state = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  blocked: [] as string[],
  cautious: false,
  results: [] as (WebResult & { savedSource?: { id: string; title: string } })[],
  pages: new Map<string, { read: ReadPage; selected: (Passage & { score: number; fallback: boolean })[]; assertReadable: () => void }>(),
  search: vi.fn(),
  read: vi.fn(),
  ready: vi.fn(),
  embed: vi.fn(),
  fetch: vi.fn()
}))
vi.mock('../../../db', () => ({ getDb: () => state.db, getSqlite: () => state.sqlite }))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getLocale: () => 'en',
    getPath: () => {
      throw new Error('No file access in chatWeb tests')
    }
  },
  nativeTheme: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../settings', () => ({
  getSettings: () => ({
    language: 'zh-CN',
    browser: { aiBlockedSites: state.blocked },
    retrieval: { ...RETRIEVAL_DEFAULTS, cautious: state.cautious, trustedSites: [], lowTrustSites: [] }
  })
}))
vi.mock('../../ai/embedding', () => ({ isReady: state.ready, embed: state.embed }))
vi.mock('../../ai/indexer', () => ({ annotationText: vi.fn(), vecBuffer: vi.fn() }))
vi.mock('../../agent/usage', () => ({ checkBudget: vi.fn() }))
vi.mock('../../jobs', () => ({
  runInWorker: () => {
    throw new Error('No worker in chatWeb tests')
  }
}))
vi.mock('../../sources', () => ({
  saveWebPage: () => {
    throw new Error('No source save in chatWeb tests')
  }
}))
vi.mock('../render', () => ({
  renderPage: () => {
    throw new Error('No browser in chatWeb tests')
  }
}))
vi.mock('../../externalFetch', async (original) => ({
  ...(await original<typeof import('../../externalFetch')>()),
  externalFetch: state.fetch
}))
// tools.ts 包含整套 UI/资料工具；这里不测试格式化或编号，保留它们在另一个 owner 的验证范围。
vi.mock('../../ai/tools', () => ({
  stepLabel: (name: string) => ({ label: name }),
  numberHits: () => {
    throw new Error('Caller owns numbering')
  }
}))
vi.mock('../../ai/webTools', async (original) => ({
  ...(await original<typeof import('../../ai/webTools')>()),
  searchForSession: state.search,
  readForSession: state.read
}))
import { currentRun, withRun } from '../../agent/context'
import { readUrl } from '../reader'
import { urlKey } from '../backends/normalize'
import { assertReadableUrl } from '../pagePolicy'
import * as scoring from '../scoring'
import { previousWebHits, runPreSearchForTurn, runPreReadForTurn } from '../../ai/chatWeb'
import { decide, denyAll, pendingApprovals } from '../../agent/approval'

const NOW = Date.UTC(2026, 9, 13, 12)
function session(): AgentSession {
  return {
    zh: true,
    model: 'controlled-model',
    tier: 'basic',
    scope: { type: 'all' },
    incognito: false,
    conversationId: 'controlled-conversation',
    messageId: 'controlled-message',
    hits: [],
    skills: [],
    web: {
      gate: { status: 'available', offerTools: true, preSearch: true, timeSensitive: false, explicitAsk: false, coverage: 'enough' },
      searches: 0,
      reads: 0,
      allowedUrls: new Set(),
      userText: 'climate adaptation'
    }
  }
}
function result(rank: number, values: Partial<WebResult & { savedSource?: { id: string; title: string } }> = {}) {
  return {
    url: `https://example.org/article-${rank}`,
    title: 'Controlled article',
    snippet: 'climate adaptation findings',
    publishedAt: NOW,
    site: 'Controlled site',
    backend: 'brave' as const,
    rank,
    ...values
  }
}
function persistPage(id: string, url: string, text: string, finalUrl = url): void {
  state
    .db!.insert(schema.webPages)
    .values({
      id,
      url,
      finalUrl,
      title: 'Snapshot article',
      siteName: 'Snapshot site',
      publishedAt: NOW,
      fetchedAt: NOW,
      method: 'fetch',
      lang: 'en',
      text,
      textHash: 'controlled-' + id
    })
    .run()
}
function addRead(
  found: WebResult,
  texts = ['climate adaptation one', 'climate adaptation two', 'climate adaptation three'],
  fallback = false,
  finalUrl = found.url
): void {
  let offset = 0
  const passages = texts.map((text, index) => {
    const start = offset
    offset += text.length + 2
    return { index, start, end: start + text.length, text, suspicious: index === 1 }
  })
  const page = {
    id: 'page-' + found.rank,
    url: found.url,
    title: found.title,
    siteName: found.site ?? null,
    publishedAt: found.publishedAt ?? null,
    fetchedAt: NOW,
    method: 'fetch' as const,
    text: texts.join('\n\n')
  }
  persistPage(page.id, page.url, page.text, finalUrl)
  state.pages.set(found.url, {
    read: { page, passages },
    selected: passages.map((passage) => ({ ...passage, score: 0.9, fallback })),
    assertReadable: () => {
      assertReadableUrl(page.url)
      assertReadableUrl(finalUrl)
    }
  })
}
function kb(id: string, values: Partial<SearchHit> = {}): SearchHit {
  state
    .db!.insert(schema.notes)
    .values({ id, title: 'Controlled note', learnedAt: NOW, editedAt: NOW, createdAt: NOW, updatedAt: NOW })
    .run()
  return {
    parentType: 'note',
    parentId: id,
    ownerId: id + ':row',
    title: 'Controlled note',
    text: 'climate adaptation note',
    locator: null,
    score: 1,
    sim: 0.8,
    learnedAt: null,
    updatedAt: null,
    status: 'active',
    origin: 'user',
    ...values
  }
}
function citation(values: Partial<Citation> = {}): Citation {
  return {
    n: 99,
    parentType: 'web',
    parentId: '',
    ownerId: 'previous-owner',
    title: 'Previous article',
    snippet: 'cached citation snippet',
    locator: null,
    learnedAt: NOW,
    updatedAt: NOW,
    status: null,
    origin: null,
    via: 'web',
    url: 'https://example.org/previous',
    ...values
  }
}
function excluded(id: string, url: string): void {
  state
    .db!.insert(schema.sources)
    .values({ id, kind: 'web', title: 'Private source', url, aiExcluded: true, accessedAt: NOW, createdAt: NOW, updatedAt: NOW })
    .run()
}
const run = <T>(fn: () => T): T => withRun({ purpose: 'chat', caller: 'assistant' }, fn)

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  state.sqlite = new Database(':memory:')
  state.sqlite.loadExtension(getLoadablePath())
  state.db = drizzle(state.sqlite, { schema })
  migrate(state.db, { migrationsFolder: 'resources/migrations' })
  state.blocked = []
  state.cautious = false
  state.results = []
  state.pages.clear()
  state.ready.mockReset().mockResolvedValue(false)
  state.embed.mockReset()
  state.search.mockReset().mockImplementation(async (s: AgentSession) => {
    s.web.searches += 1
    for (const found of state.results) {
      const key = urlKey(found.url)
      if (key) s.web.allowedUrls.add(key)
    }
    return { results: state.results, backendLabel: 'Controlled backend' }
  })
  state.read.mockReset().mockImplementation(async (s: AgentSession, url: string) => {
    s.web.reads += 1
    const response = state.pages.get(url)
    if (!response) throw new Error('Controlled read failed')
    return response
  })
  state.fetch.mockReset().mockImplementation(async (url, opts) => {
    opts?.validateUrl?.(url)
    const body = '<html><body><article><p>' + 'climate adaptation public article. '.repeat(40) + '</p></article></body></html>'
    return { status: 200, text: body, bytes: new TextEncoder().encode(body), headers: new Headers({ 'content-type': 'text/html' }) }
  })
})
afterEach(() => {
  denyAll()
  state.sqlite?.close()
  state.sqlite = null
  state.db = null
  vi.restoreAllMocks()
})

describe('direct page reading before model generation', () => {
  it('reads at most two supplied pages without Search and keeps knowledge evidence', async () => {
    const s = session(),
      knowledge = kb('direct-knowledge'),
      steps: AgentStep[] = []
    const found = [result(1), result(2), result(3)]
    found.forEach((entry) => addRead(entry))
    s.web.gate = { ...s.web.gate, status: 'read-only', preRead: true, preSearch: false }
    const output = await run(() =>
      runPreReadForTurn(
        s,
        found.map((entry) => entry.url),
        { kbHits: [knowledge], pushStep: (step) => steps.push(step) }
      )
    )
    expect(state.search).not.toHaveBeenCalled()
    expect(state.read).toHaveBeenCalledTimes(2)
    expect(output.kbHits).toEqual([knowledge])
    expect(output.webHits.length).toBeGreaterThan(0)
    expect(output.webHits.every((hit) => hit.locator?.startsWith('chars='))).toBe(true)
    expect(steps.filter((step) => step.status === 'done')).toHaveLength(2)
  })
  it('waits for cautious-mode confirmation and never reads a declined page', async () => {
    state.cautious = true
    const s = session(),
      steps: AgentStep[] = []
    const done = run(() => runPreReadForTurn(s, [result(1).url], { kbHits: [], pushStep: (step) => steps.push(step) }))
    expect(state.read).not.toHaveBeenCalled()
    const approval = pendingApprovals().find((item) => item.messageId === s.messageId)!
    expect(approval.tool).toBe('read_url')
    expect(steps[0].approval?.state).toBe('pending')
    decide(approval.id, false)
    await done
    expect(state.read).not.toHaveBeenCalled()
    expect(steps.at(-1)?.status).toBe('denied')
  })
  it('never restores cloud citations, even after their snapshots have been removed', () => {
    const origin = { provider: 'deepseek' as const, urlVerified: false as const, truncated: false }
    expect(previousWebHits(session(), [citation({ webOrigin: origin, parentId: 'missing-cloud' })])).toEqual([])
    persistPage('old-cloud', result(1).url, 'cloud snippet')
    state.sqlite!.prepare("UPDATE web_pages SET provider='deepseek', final_url=NULL WHERE id='old-cloud'").run()
    expect(previousWebHits(session(), [citation({ parentId: 'old-cloud', url: result(1).url })])).toEqual([])
  })
})

describe('proactive turn search', () => {
  it('builds a short query and forwards the turn signal without doing numbering', async () => {
    const s = session(),
      controller = new AbortController(),
      steps: AgentStep[] = []
    s.web.userText = 'please search for climate adaptation?'
    const before = kb('already-numbered')
    s.hits = [before]
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], signal: controller.signal, pushStep: (step) => steps.push(step) }))
    expect(state.search).toHaveBeenCalledOnce()
    expect(state.search.mock.calls[0][1]).toEqual({ query: 'climate adaptation' })
    expect(state.search.mock.calls[0][2]).toBe(controller.signal)
    expect(output).toEqual({ kbHits: [], webHits: [], failed: false })
    expect(steps).toMatchObject([{ id: 'pre-search', tool: 'web_search', status: 'done', detail: 'Controlled backend' }])
    expect(s.hits).toEqual([before])
  })

  it('uses previous user wording when the stripped query is shorter than six characters', async () => {
    const s = session()
    s.web.userText = '请告诉我价格呢？'
    await run(() => runPreSearchForTurn(s, { kbHits: [], prevUserText: 'DeepSeek API', pushStep: () => {} }))
    expect(state.search).toHaveBeenCalledOnce()
    expect(state.search.mock.calls[0][1]).toEqual({ query: 'DeepSeek API 价格' })
  })

  it('reads only the first two ranked results and allocates twelve slots while preserving passage metadata', async () => {
    const s = session(),
      steps: AgentStep[] = [],
      knowledge = Array.from({ length: 8 }, (_, i) => kb('note-' + i))
    state.results = [result(3), result(1), result(2), result(4), result(5), result(6)]
    addRead(state.results[1])
    addRead(state.results[2])
    const output = await run(async () => {
      const output = await runPreSearchForTurn(s, { kbHits: knowledge, pushStep: (step) => steps.push(step) })
      expect(currentRun()!.state.tainted).toBe(true)
      return output
    })
    expect(state.read.mock.calls.map((call) => call[1])).toEqual(['https://example.org/article-1', 'https://example.org/article-2'])
    expect(output.kbHits).toHaveLength(4)
    expect(output.webHits).toHaveLength(8)
    expect(output.webHits.filter((hit) => hit.parentId === 'page-1')).toHaveLength(2)
    expect(output.webHits.filter((hit) => hit.parentId === 'page-2')).toHaveLength(2)
    expect(output.webHits.filter((hit) => hit.snippetOnly)).toHaveLength(4)
    expect(output.webHits.find((hit) => hit.parentId === 'page-1' && hit.suspicious)).toMatchObject({
      locator: 'chars=24-46',
      text: 'climate adaptation two',
      url: 'https://example.org/article-1',
      site: 'Controlled site',
      learnedAt: NOW,
      updatedAt: NOW,
      via: 'web'
    })
    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ['pre-search', 'done'],
      ['pre-read-0', 'done'],
      ['pre-read-1', 'done']
    ])
    expect(s.web.searches).toBe(1)
    expect(s.web.reads).toBe(2)
  })

  it('keeps saved or unreadable first-two results from causing replacement reads', async () => {
    const s = session()
    state.results = [
      result(3),
      result(1, { savedSource: { id: 'saved', title: 'Saved article' } }),
      result(2, { url: 'https://mail.example.org/inbox' })
    ]
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(state.read).not.toHaveBeenCalled()
    expect(output.webHits.map((hit) => hit.url)).toEqual(['https://example.org/article-1', 'https://example.org/article-3'])
    expect(output.webHits.every((hit) => hit.snippetOnly)).toBe(true)
  })

  it('keeps a failed read as a snippet, continues the second read and sanitizes its error step', async () => {
    const s = session(),
      steps: AgentStep[] = []
    state.results = [result(1), result(2), result(3)]
    addRead(state.results[1])
    state.read.mockImplementation(async (session: AgentSession, url: string) => {
      session.web.reads++
      if (url.endsWith('article-1')) throw new Error('PRIVATE_QUERY sk-controlled-secret /private/path')
      return state.pages.get(url)!
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: (step) => steps.push(step) }))
    expect(output.failed).toBe(false)
    expect(output.webHits.find((hit) => hit.url === 'https://example.org/article-1')).toMatchObject({ snippetOnly: true })
    expect(output.webHits.filter((hit) => hit.parentId === 'page-2')).toHaveLength(2)
    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ['pre-search', 'done'],
      ['pre-read-0', 'error'],
      ['pre-read-1', 'done']
    ])
    expect(steps[1].detail).toBeTruthy()
    expect(JSON.stringify(steps)).not.toMatch(/PRIVATE_QUERY|sk-controlled-secret|\/private\/path/)
  })

  it('reports selected paragraph count and low-relevance fallback without altering passage text', async () => {
    const s = session(),
      steps: AgentStep[] = []
    state.results = [result(1)]
    addRead(state.results[0], ['climate adaptation original paragraph'], true)
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: (step) => steps.push(step) }))
    expect(output.webHits).toMatchObject([{ text: 'climate adaptation original paragraph' }])
    expect(steps).toHaveLength(2)
    expect(steps[1].detail).toContain('1')
    expect(steps[1].detail).toContain('相关度较低')
  })

  it('retains academic metadata and backend authority during snippet scoring', async () => {
    const s = session(),
      meta = {
        authors: ['Fixture Author'],
        year: 2026,
        venue: 'Fixture Venue',
        citations: 8,
        doi: '10.0000/fixture',
        pdfUrl: 'https://example.org/paper.pdf'
      }
    state.results = [
      result(1, { ...meta, backend: 'arxiv', savedSource: { id: 'saved-1', title: 'One' } }),
      result(2, { savedSource: { id: 'saved-2', title: 'Two' } })
    ]
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(output.webHits[0]).toMatchObject({ meta, snippetOnly: true, score: 1.2 })
    expect(output.webHits[1].score).toBeCloseTo(0.9)
  })

  it('does not taint the run when no webpage candidate survives allocation', async () => {
    const s = session(),
      knowledge = kb('preserved')
    state.results = [result(1, { snippet: 'unrelated zebra', savedSource: { id: 'saved', title: 'Saved' } })]
    await run(async () => {
      const output = await runPreSearchForTurn(s, { kbHits: [knowledge], pushStep: () => {} })
      expect(output).toEqual({ kbHits: [knowledge], webHits: [], failed: false })
      expect(currentRun()!.state.tainted).toBe(false)
    })
  })

  it('preserves knowledge retrieval without allocation when proactive search fails', async () => {
    const s = session(),
      knowledge = Array.from({ length: 15 }, (_, i) => kb('failure-note-' + i)),
      steps: AgentStep[] = []
    state.search.mockRejectedValue(new Error('PRIVATE_QUERY sk-controlled-secret /private/path'))
    await run(async () => {
      const output = await runPreSearchForTurn(s, { kbHits: knowledge, pushStep: (step) => steps.push(step) })
      expect(output).toEqual({ kbHits: knowledge, webHits: [], failed: true })
      expect(currentRun()!.state.tainted).toBe(false)
    })
    expect(state.read).not.toHaveBeenCalled()
    expect(steps).toMatchObject([{ id: 'pre-search', status: 'error' }])
    expect(JSON.stringify(steps)).not.toMatch(/PRIVATE_QUERY|sk-controlled-secret|\/private\/path/)
  })

  it.each(['off', 'academic-only', 'context', 'unconfigured', 'not-allowed'] as const)(
    'rejects proactive calls for gate %s',
    async (status) => {
      const s = session()
      s.web.gate.status = status
      await expect(run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))).rejects.toThrow()
      expect(state.search).not.toHaveBeenCalled()
    }
  )

  it('rejects proactive calls in cautious mode', async () => {
    const s = session()
    s.web.gate.preSearch = false
    state.blocked = []
    // gate 不保存 cautious 字段；主动调用仍须重读真实设置中的 cautious 开关。
    state.cautious = true
    await expect(run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))).rejects.toThrow()
    expect(state.search).not.toHaveBeenCalled()
  })

  it('supports the unsupported-tools retry even when the original gate preSearch was false', async () => {
    const s = session()
    s.web.gate.preSearch = false
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(output.failed).toBe(false)
    expect(state.search).toHaveBeenCalledOnce()
  })

  it('filters current exclusions before embedding and after asynchronous scoring', async () => {
    const s = session()
    state.results = [result(1, { savedSource: { id: 'saved', title: 'Saved' } })]
    state.ready.mockResolvedValue(true)
    state.embed.mockResolvedValueOnce([[1, 0]]).mockImplementationOnce(async (texts: string[]) => {
      state.blocked = ['example.org']
      return texts.map(() => [1, 0])
    })
    await run(async () => {
      const output = await runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} })
      expect(output.webHits).toEqual([])
      expect(currentRun()!.state.tainted).toBe(false)
    })
    expect(state.embed).toHaveBeenCalledTimes(2)
    expect(state.embed.mock.calls[1][0]).toEqual(['climate adaptation findings'])
  })

  it('stops unconfirmed reads if cautious mode is enabled while search is awaiting', async () => {
    const s = session()
    state.results = [result(1), result(2)]
    state.search.mockImplementation(async () => {
      state.cautious = true
      return { results: state.results, backendLabel: 'Controlled backend' }
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(state.read).not.toHaveBeenCalled()
    expect(output.webHits).toHaveLength(2)
    expect(output.webHits.every((hit) => hit.snippetOnly)).toBe(true)
  })

  it('rechecks knowledge privacy after asynchronous webpage scoring', async () => {
    const s = session(),
      knowledge = kb('changed-privacy')
    state.results = [result(1, { savedSource: { id: 'saved', title: 'Saved' } })]
    state.ready.mockResolvedValue(true)
    state.embed.mockResolvedValueOnce([[1, 0]]).mockImplementationOnce(async (texts: string[]) => {
      state.sqlite!.prepare('UPDATE notes SET ai_excluded=1 WHERE id=?').run('changed-privacy')
      return texts.map(() => [1, 0])
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [knowledge], pushStep: () => {} }))
    expect(output.kbHits).toEqual([])
    expect(output.webHits).toHaveLength(1)
  })

  it('blocks document embedding when privacy changes while the query vector is awaiting', async () => {
    const s = session()
    state.results = [result(1, { savedSource: { id: 'saved', title: 'Saved' } })]
    state.ready.mockResolvedValue(true)
    let documentsSent = 0
    state.embed.mockImplementation(async (texts: string[], kind: 'query' | 'doc', _titles?: string[], beforeSend?: () => void) => {
      beforeSend?.()
      if (kind === 'query') state.blocked = ['example.org']
      else documentsSent += texts.length
      beforeSend?.()
      return texts.map(() => [1, 0])
    })
    await run(async () => {
      const output = await runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} })
      expect(documentsSent).toBe(0)
      expect(output).toEqual({ kbHits: [], webHits: [], failed: true })
      expect(currentRun()!.state.tainted).toBe(false)
    })
  })

  it('blocks the first embedding send when privacy changes while readiness is awaiting', async () => {
    const s = session()
    state.results = [result(1, { savedSource: { id: 'saved', title: 'Saved' } })]
    state.ready.mockImplementation(async () => {
      state.blocked = ['example.org']
      return true
    })
    let queriesSent = 0
    state.embed.mockImplementation(async (texts: string[], kind: 'query' | 'doc', _titles?: string[], beforeSend?: () => void) => {
      beforeSend?.()
      if (kind === 'query') queriesSent += texts.length
      return texts.map(() => [1, 0])
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(queriesSent).toBe(0)
    expect(output).toEqual({ kbHits: [], webHits: [], failed: true })
  })

  it('blocks captured final URLs even when cache clearing removes snapshot metadata during query scoring', async () => {
    const s = session()
    state.results = [result(1)]
    addRead(state.results[0], ['climate adaptation captured article'], false, 'https://restricted.example.org/final')
    state.ready.mockResolvedValue(true)
    let documentsSent = 0
    state.embed.mockImplementation(async (texts: string[], kind: 'query' | 'doc', _titles?: string[], beforeSend?: () => void) => {
      beforeSend?.()
      if (kind === 'query') {
        state.sqlite!.prepare('DELETE FROM web_pages WHERE id=?').run('page-1')
        state.blocked = ['restricted.example.org']
      } else documentsSent += texts.length
      beforeSend?.()
      return texts.map(() => [1, 0])
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(documentsSent).toBe(0)
    expect(output).toEqual({ kbHits: [], webHits: [], failed: true })
  })

  it('keeps a legal captured article usable after cache clearing', async () => {
    const s = session()
    state.results = [result(1)]
    addRead(state.results[0], ['climate adaptation captured article'], false, 'https://restricted.example.org/final')
    state.ready.mockResolvedValue(true)
    let documentsSent = 0
    state.embed.mockImplementation(async (texts: string[], kind: 'query' | 'doc', _titles?: string[], beforeSend?: () => void) => {
      beforeSend?.()
      if (kind === 'query') state.sqlite!.prepare('DELETE FROM web_pages WHERE id=?').run('page-1')
      else documentsSent += texts.length
      beforeSend?.()
      return texts.map(() => [1, 0])
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(documentsSent).toBe(1)
    expect(output.failed).toBe(false)
    expect(output.webHits).toMatchObject([{ parentId: 'page-1', text: 'climate adaptation captured article' }])
  })

  it('rechecks the current turn page guard before scoring sends when fixture reads have no captured guard', async () => {
    const s = session()
    state.results = [result(1)]
    addRead(state.results[0], ['climate adaptation captured article'], false, 'https://restricted.example.org/final')
    state.pages.get(state.results[0].url)!.assertReadable = () => {}
    s.web.pageGuards = new Map([['page-1', () => assertReadableUrl('https://restricted.example.org/final')]])
    state.ready.mockResolvedValue(true)
    let documentsSent = 0
    state.embed.mockImplementation(async (texts: string[], kind: 'query' | 'doc', _titles?: string[], beforeSend?: () => void) => {
      beforeSend?.()
      if (kind === 'query') {
        state.sqlite!.prepare('DELETE FROM web_pages WHERE id=?').run('page-1')
        state.blocked = ['restricted.example.org']
      } else documentsSent += texts.length
      beforeSend?.()
      return texts.map(() => [1, 0])
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(documentsSent).toBe(0)
    expect(output).toEqual({ kbHits: [], webHits: [], failed: true })
  })

  it('keeps cancellation checks during captured article scoring without exposing the abort reason', async () => {
    const s = session(),
      controller = new AbortController()
    const steps: AgentStep[] = []
    state.results = [result(1)]
    addRead(state.results[0], ['climate adaptation captured article'])
    state.ready.mockResolvedValue(true)
    let documentsSent = 0
    state.embed.mockImplementation(async (texts: string[], kind: 'query' | 'doc', _titles?: string[], beforeSend?: () => void) => {
      beforeSend?.()
      if (kind === 'query') controller.abort('PRIVATE_ABORT_REASON')
      else documentsSent += texts.length
      beforeSend?.()
      return texts.map(() => [1, 0])
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], signal: controller.signal, pushStep: (step) => steps.push(step) }))
    expect(documentsSent).toBe(0)
    expect(output).toEqual({ kbHits: [], webHits: [], failed: true })
    expect(JSON.stringify(steps)).not.toContain('PRIVATE_ABORT_REASON')
    expect(steps).toMatchObject([{ status: 'done' }, { status: 'done' }, { tool: 'web_search', status: 'error' }])
  })

  it('filters captured final URLs after scoring before they consume knowledge allocation slots', async () => {
    const s = session(),
      knowledge = Array.from({ length: 15 }, (_, i) => kb('captured-allocation-' + i))
    state.results = [result(1)]
    addRead(state.results[0], ['climate adaptation captured article'], false, 'https://restricted.example.org/final')
    const scoreWeb = scoring.scoreWeb
    // 使用实际评分，只在评分promise完成到caller继续之间模拟清缓存及权限变化。
    vi.spyOn(scoring, 'scoreWeb').mockImplementationOnce(async (...args) => {
      const scored = await scoreWeb(...args)
      state.sqlite!.prepare('DELETE FROM web_pages WHERE id=?').run('page-1')
      state.blocked = ['restricted.example.org']
      return scored
    })
    await run(async () => {
      const output = await runPreSearchForTurn(s, { kbHits: knowledge, pushStep: () => {} })
      expect(output.kbHits).toHaveLength(12)
      expect(output.webHits).toEqual([])
      expect(output.failed).toBe(false)
      expect(currentRun()!.state.tainted).toBe(false)
    })
  })

  it('preserves original knowledge when the current privacy guard cancels webpage scoring', async () => {
    const s = session(),
      knowledge = Array.from({ length: 15 }, (_, i) => kb('allocation-note-' + i))
    state.results = [
      result(1, { savedSource: { id: 'saved-one', title: 'One' } }),
      result(2, { savedSource: { id: 'saved-two', title: 'Two' } })
    ]
    state.ready.mockResolvedValue(true)
    state.embed.mockResolvedValueOnce([[1, 0]]).mockImplementationOnce(async (texts: string[]) => {
      state.blocked = ['example.org']
      return texts.map(() => [1, 0])
    })
    const output = await run(() => runPreSearchForTurn(s, { kbHits: knowledge, pushStep: () => {} }))
    expect(output).toEqual({ kbHits: knowledge, webHits: [], failed: true })
  })

  it('does not send excluded snippets or excluded PDF metadata to embedding', async () => {
    const s = session()
    state.results = [result(1, { savedSource: { id: 'saved', title: 'Saved' } }), result(2, { pdfUrl: 'https://example.org/private.pdf' })]
    excluded('private-page', state.results[0].url)
    excluded('private-pdf', 'https://example.org/private.pdf')
    state.ready.mockResolvedValue(true)
    state.embed.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0]))
    const output = await run(() => runPreSearchForTurn(s, { kbHits: [], pushStep: () => {} }))
    expect(output.webHits).toEqual([])
    expect(state.embed).not.toHaveBeenCalled()
  })
})

describe('previous successful web citations', () => {
  it('restores exact UTF-16 chars passages and retains metadata without doing numbering', () => {
    const s = session(),
      meta = { authors: ['Fixture Author'], year: 2026, doi: '10.0000/fixture' },
      before = kb('numbered-before')
    s.hits = [before]
    persistPage('snapshot', 'https://example.org/previous', 'prefix climate adaptation suffix')
    const cites = [
      citation({
        parentId: 'snapshot',
        ownerId: 'snapshot:7',
        locator: 'chars=7-25',
        snippet: 'short stale snippet',
        site: 'Fixture site',
        suspicious: true,
        meta
      })
    ]
    const hits = run(() => {
      const hits = previousWebHits(s, cites)
      expect(currentRun()!.state.tainted).toBe(true)
      return hits
    })
    expect(hits).toMatchObject([
      { ownerId: 'snapshot:7', text: 'climate adaptation', locator: 'chars=7-25', site: 'Fixture site', suspicious: true, meta }
    ])
    expect(s.web.allowedUrls.has('https://example.org/previous')).toBe(true)
    expect(s.hits).toEqual([before])
    persistPage('unicode-snapshot', 'https://example.org/unicode', '甲🧠乙')
    expect(
      run(() =>
        previousWebHits(s, [citation({ parentId: 'unicode-snapshot', url: 'https://example.org/unicode', locator: 'chars=1-3' })])
      )[0].text
    ).toBe('🧠')
  })

  it.each(['chars=-1-2', 'chars=2-1', 'chars=0-0', 'chars=0-999', 'chars=0-9007199254740993', 'chars=1-2junk', 'page=1', null])(
    'uses the saved snippet for invalid selector %s',
    (locator) => {
      persistPage('snapshot', 'https://example.org/previous', 'controlled snapshot body')
      const hits = run(() => previousWebHits(session(), [citation({ parentId: 'snapshot', locator })]))
      expect(hits).toMatchObject([{ text: 'cached citation snippet', locator: null }])
    }
  )

  it('uses saved snippets for missing and temporary snapshots', async () => {
    const s = session()
    const temporary = await run(() => readUrl('https://example.org/temporary', { incognito: true }))
    const hits = run(() =>
      previousWebHits(s, [
        citation({ parentId: 'missing', locator: 'chars=0-5' }),
        citation({
          parentId: temporary.page.id,
          url: temporary.page.url,
          ownerId: 'temporary-owner',
          locator: 'chars=0-5',
          snippet: 'temporary saved snippet'
        })
      ])
    )
    expect(hits.map((hit) => hit.text)).toEqual(['cached citation snippet', 'temporary saved snippet'])
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_pages').get()).toEqual({ n: 0 })
  })

  it('filters current privacy before limiting surviving references to six', () => {
    const s = session(),
      privateCites = Array.from({ length: 7 }, (_, i) => citation({ ownerId: 'private-' + i, url: `https://example.org/private-${i}` }))
    for (const [index, cite] of privateCites.entries()) excluded('private-' + index, cite.url!)
    const publicCites = Array.from({ length: 8 }, (_, i) => citation({ ownerId: 'public-' + i, url: `https://example.org/public-${i}` }))
    const output = run(() => previousWebHits(s, [...privateCites, ...publicCites]))
    expect(output.map((hit) => hit.ownerId)).toEqual(['public-0', 'public-1', 'public-2', 'public-3', 'public-4', 'public-5'])
    expect(s.web.allowedUrls.size).toBe(6)
    expect(s.web.allowedUrls.has('https://example.org/private-0')).toBe(false)
  })

  it('never falls back to a saved snippet when a snapshot final URL is now excluded', () => {
    const s = session()
    persistPage('snapshot', 'https://example.org/previous', 'private snapshot body', 'https://private.example.org/final')
    state.blocked = ['private.example.org']
    run(() => {
      expect(previousWebHits(s, [citation({ parentId: 'snapshot', locator: 'chars=0-7' })])).toEqual([])
      expect(currentRun()!.state.tainted).toBe(false)
    })
    expect(s.web.allowedUrls.size).toBe(0)
  })

  it('rechecks changed page and PDF privacy on each build instead of caching recovered excerpts', () => {
    const s = session(),
      cite = citation({ meta: { pdfUrl: 'https://example.org/paper.pdf' } })
    expect(run(() => previousWebHits(s, [cite]))).toHaveLength(1)
    excluded('private-pdf', cite.meta!.pdfUrl!)
    expect(run(() => previousWebHits(session(), [cite]))).toEqual([])
  })

  it('excludes a temporary snapshot whose final URL was excluded after the prior read', async () => {
    state.fetch.mockImplementationOnce(async (_url, options) => {
      options?.validateUrl?.('https://private.example.org/final')
      const body = '<html><body><article><p>' + 'climate adaptation public article. '.repeat(40) + '</p></article></body></html>'
      return { status: 200, text: body, bytes: new TextEncoder().encode(body), headers: new Headers({ 'content-type': 'text/html' }) }
    })
    const privateRead = await run(() => readUrl('https://example.org/temporary', { incognito: true }))
    state.blocked = ['private.example.org']
    expect(run(() => previousWebHits(session(), [citation({ parentId: privateRead.page.id, url: privateRead.page.url })]))).toEqual([])
  })

  it('rejects missing/invalid URLs and skips non-web or empty excerpts without taint', () => {
    const s = session()
    run(() => {
      const output = previousWebHits(s, [
        citation({ url: undefined }),
        citation({ url: 'file:///private' }),
        citation({ parentType: 'note' }),
        citation({ snippet: '' })
      ])
      expect(output).toEqual([])
      expect(currentRun()!.state.tainted).toBe(false)
    })
    expect(s.web.allowedUrls.size).toBe(0)
  })
})
