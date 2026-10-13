import type { RetrievalUsage } from '@shared/retrieval'
import { getDb, getSqlite } from '../../db'
import { retrievalCalls } from '../../db/schema'
import { newId } from '../../lib/ids'
import { tr } from '../../lib/messages'
import { currentRun } from '../agent/context'
import { getSettings } from '../settings'
import { localDate } from '../stats'

const pending = new Map<string, number>()
export class DailyLimitError extends Error {
  constructor(readonly limit: number) {
    super(
      tr(
        `今天的联网次数已达到上限（${limit} 次），可以在设置 → 联网搜索 中调整`,
        `Today's web call limit (${limit}) has been reached. You can change it in Settings → Web search.`
      )
    )
    this.name = 'DailyLimitError'
  }
}

export function todayCalls(): number {
  return (getSqlite().prepare('SELECT COUNT(*) AS n FROM retrieval_calls WHERE date = ? AND cached = 0').get(localDate()) as { n: number })
    .n
}

/** 先预留真实请求名额，避免并发学术后端共同穿透每日上限。命中缓存不预留。 */
export function reserveCall(): () => void {
  const date = localDate(),
    limit = getSettings().retrieval.dailyLimit
  if (todayCalls() + (pending.get(date) ?? 0) >= limit) throw new DailyLimitError(limit)
  pending.set(date, (pending.get(date) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (pending.get(date) ?? 1) - 1
    if (left) pending.set(date, left)
    else pending.delete(date)
  }
}

export function recordCall(
  backend: string,
  kind: 'search' | 'fetch' | 'render' | 'pdf',
  ok: boolean,
  cached: boolean,
  start: number
): void {
  const run = currentRun()
  getDb()
    .insert(retrievalCalls)
    .values({
      id: newId(),
      at: Date.now(),
      date: localDate(),
      backend,
      kind,
      purpose: run?.purpose ?? 'other',
      runId: run?.id ?? null,
      conversationId: run?.conversationId ?? null,
      ok,
      cached,
      durationMs: Math.max(0, Date.now() - start)
    })
    .run()
}

export function retrievalUsage(range: 'today' | 'month'): RetrievalUsage {
  const start = range === 'today' ? localDate() : localDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const db = getSqlite()
  const totals = db
    .prepare(
      'SELECT COUNT(*) AS total, coalesce(sum(cached),0) AS cached, coalesce(sum(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) AS failed FROM retrieval_calls WHERE date >= ?'
    )
    .get(start) as Pick<RetrievalUsage, 'total' | 'cached' | 'failed'>
  const byBackend = db
    .prepare('SELECT backend, COUNT(*) AS calls FROM retrieval_calls WHERE date >= ? GROUP BY backend ORDER BY calls DESC, backend')
    .all(start) as RetrievalUsage['byBackend']
  return { range, ...totals, byBackend }
}
