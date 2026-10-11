import { dialog } from 'electron'
import { readFile, stat } from 'fs/promises'
import { basename, extname } from 'path'
import { eq, isNull } from 'drizzle-orm'
import type { z } from 'zod'
import { IcsSave, addDays, dayStart, type IcsFeed } from '@shared/plan'
import type { IcsOccurrence } from '../../lib/ics'
import { getDb } from '../../db'
import { icsFeeds, planEvents } from '../../db/schema'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { emit } from '../../events'
import { enqueue, registerJobKind, runInWorker } from '../jobs'
import { checkedWebUrl, externalFetch } from '../externalFetch'
import { audit } from '../agent/audit'
import { getSettings } from '../settings'

const inFlight = new Map<string, Promise<void>>()
export function feeds(): IcsFeed[] {
  return getDb().select().from(icsFeeds).where(isNull(icsFeeds.deletedAt)).all()
}
function replaceEvents(feedId: string, rows: IcsOccurrence[]): void {
  const now = Date.now(),
    db = getDb()
  db.transaction((tx) => {
    // 保留墓碑与稳定 ID；同订阅的完整快照在一个事务里替换，读者不会看见空窗。
    tx.update(planEvents).set({ deletedAt: now, updatedAt: now, updatedBy: deviceId() }).where(eq(planEvents.feedId, feedId)).run()
    for (const r of rows) {
      const value = { ...r, feedId, kind: 'event' as const, origin: 'ics' as const, deletedAt: null, updatedAt: now, updatedBy: deviceId() }
      tx.insert(planEvents)
        .values({ ...value, id: newId(), createdAt: now })
        .onConflictDoUpdate({ target: [planEvents.feedId, planEvents.uid, planEvents.startAt], set: value })
        .run()
    }
  })
}
async function parse(body: string): Promise<IcsOccurrence[]> {
  const now = dayStart(),
    range = { startAt: addDays(now, -30), endAt: addDays(now, 181) }
  return runInWorker<IcsOccurrence[]>('parseICS', { body, range }, undefined, AbortSignal.timeout(15000))
}
export function refresh(id: string): Promise<void> {
  if (inFlight.has(id)) return inFlight.get(id)!
  const db = getDb()
  const active = (): boolean => {
    try {
      return getDb() === db
    } catch {
      return false
    }
  }
  const promise = (async () => {
    const feed = feeds().find((f) => f.id === id)
    if (!feed || !feed.enabled || feed.url.startsWith('file:')) return
    try {
      const headers: Record<string, string> = {}
      if (feed.etag) headers['If-None-Match'] = feed.etag
      if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified
      const r = await externalFetch(feed.url, { headers, httpsOnly: true })
      if (!active() || !feeds().some((f) => f.id === id && f.enabled)) return
      if (r.status !== 304) {
        if (r.status !== 200) throw new Error('Calendar fetch failed')
        const rows = await parse(r.text)
        if (!active() || !feeds().some((f) => f.id === id && f.enabled)) return
        replaceEvents(id, rows)
      }
      db.update(icsFeeds)
        .set({
          lastFetchedAt: Date.now(),
          error: null,
          etag: r.headers.get('etag') ?? feed.etag,
          lastModified: r.headers.get('last-modified') ?? feed.lastModified
        })
        .where(eq(icsFeeds.id, id))
        .run()
      audit({ caller: 'calendar', tool: 'plan.ics.refresh', level: 'write', summary: 'Refresh subscribed calendar', status: 'ok' })
    } catch {
      if (!active()) return
      // 网络异常可能携带带令牌的 URL，既不存原始异常，也不记录订阅正文。
      db.update(icsFeeds)
        .set({
          lastFetchedAt: Date.now(),
          error: getSettings().language.startsWith('zh')
            ? '刷新失败，保留上次成功的日程'
            : 'Refresh failed; last successful events retained'
        })
        .where(eq(icsFeeds.id, id))
        .run()
      audit({
        caller: 'calendar',
        tool: 'plan.ics.refresh',
        level: 'write',
        summary: 'Calendar refresh failed; retained prior events',
        status: 'error'
      })
      throw new Error('Calendar refresh failed')
    } finally {
      emit('plan:changed', {})
    }
  })().finally(() => inFlight.delete(id))
  inFlight.set(id, promise)
  return promise
}
export function save(input: z.input<typeof IcsSave>): IcsFeed {
  const v = IcsSave.parse(input),
    db = getDb(),
    old = v.id ? feeds().find((f) => f.id === v.id) : undefined
  if (v.id && !old) throw new Error('Calendar subscription not found')
  const url = old?.url.startsWith('file:') && old.url === v.url ? v.url : checkedWebUrl(v.url, true).href
  const id = v.id ?? newId(),
    now = Date.now(),
    changed = !old || old.url !== url
  const row = {
    name: v.name,
    url,
    color: v.color ?? null,
    enabled: v.enabled,
    updatedAt: now,
    updatedBy: deviceId(),
    ...(changed ? { etag: null, lastModified: null, lastFetchedAt: null, error: null } : {})
  }
  if (old) db.update(icsFeeds).set(row).where(eq(icsFeeds.id, id)).run()
  else
    db.insert(icsFeeds)
      .values({ ...row, id, createdAt: now })
      .run()
  if (v.enabled && (changed || !old?.enabled)) enqueue('plan.ics', { feedId: id }, { dedupeKey: `ics:${id}` })
  emit('plan:changed', {})
  return feeds().find((f) => f.id === id)!
}
export function remove(id: string): void {
  const db = getDb(),
    now = Date.now()
  db.transaction((tx) => {
    tx.update(icsFeeds).set({ deletedAt: now, updatedAt: now, updatedBy: deviceId() }).where(eq(icsFeeds.id, id)).run()
    tx.update(planEvents).set({ deletedAt: now, updatedAt: now, updatedBy: deviceId() }).where(eq(planEvents.feedId, id)).run()
  })
  emit('plan:changed', {})
}
export async function importFile(): Promise<IcsFeed | null> {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'iCalendar', extensions: ['ics'] }] })
  if (r.canceled || !r.filePaths[0]) return null
  const path = r.filePaths[0]
  if (extname(path).toLowerCase() !== '.ics' || (await stat(path)).size > 2 * 1024 * 1024) throw new Error('Invalid calendar file')
  const db = getDb(),
    rows = await parse(await readFile(path, 'utf8'))
  if (getDb() !== db) throw new Error('Knowledge base changed')
  const id = newId(),
    now = Date.now()
  db.transaction((tx) => {
    tx.insert(icsFeeds)
      .values({
        id,
        name: basename(path),
        url: `file:${id}`,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        updatedBy: deviceId(),
        lastFetchedAt: now
      })
      .run()
    replaceEvents(id, rows)
  })
  emit('plan:changed', {})
  return feeds().find((f) => f.id === id)!
}
export function checkIcs(now = Date.now()): void {
  for (const f of feeds())
    if (f.enabled && !f.url.startsWith('file:') && (!f.lastFetchedAt || now - f.lastFetchedAt >= 6 * 3600000))
      enqueue('plan.ics', { feedId: f.id }, { dedupeKey: `ics:${f.id}` })
}
export function registerIcsJobs(): void {
  registerJobKind<{ feedId: string }>('plan.ics', {
    title: () => (getSettings().language.startsWith('zh') ? '刷新订阅日历' : 'Refresh calendars'),
    run: async ({ feedId }) => {
      await refresh(feedId)
      return { refreshed: true }
    }
  })
}
