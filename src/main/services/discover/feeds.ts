import { and, eq, isNull, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { parseHTML } from 'linkedom'
import { FeedSave, type Feed, type FeedInput } from '@shared/discover'
import { getDb } from '../../db'
import { feeds, feedItems, goals, inboxItems, jobs } from '../../db/schema'
import { emit } from '../../events'
import { newId } from '../../lib/ids'
import { normalizeFeed, parseFeed, type ParsedItem } from '../../lib/feedParser'
import { deviceId } from '../device'
import { externalFetch, checkedWebUrl } from '../externalFetch'
import { fetchWebText } from '../webText'
import { getSettings } from '../settings'
import { isSensitiveUrl } from '../../lib/browserPolicy'
import { audit } from '../agent/audit'
import { enqueue, registerJobKind, cancelJob } from '../jobs'
import { tr } from '../../lib/messages'

// 提取方式升级先重建基线，不能把旧页面因提取规则变化当作新内容投递。
const WEB_HASH_PREFIX = 'visible-html-v1:'
export const discoverChanged = (): void => emit('discover:changed', {})
export function checkDiscoverUrl(url: string): void {
  checkedWebUrl(url)
  if (isSensitiveUrl(url, getSettings().browser?.aiBlockedSites ?? []))
    throw new Error(tr('该网站已设置为不给 AI', 'This site is excluded from AI'))
}
export function listFeeds(): Feed[] {
  return getDb().select().from(feeds).where(isNull(feeds.deletedAt)).all() as Feed[]
}
export function saveFeed(input: FeedInput): Feed {
  const v = FeedSave.parse(input),
    normalized = normalizeFeed(v.url, v.kind),
    db = getDb(),
    now = Date.now()
  checkDiscoverUrl(normalized.url)
  if (
    v.goalId &&
    !db
      .select()
      .from(goals)
      .where(and(eq(goals.id, v.goalId), isNull(goals.deletedAt)))
      .get()
  )
    throw new Error('Direction not found')
  const old = v.id ? db.select().from(feeds).where(eq(feeds.id, v.id)).get() : undefined
  if (v.id && (!old || old.deletedAt)) throw new Error('Feed not found')
  const id = v.id ?? newId(),
    changed = old && (old.url !== normalized.url || old.kind !== normalized.kind)
  const row = {
    ...normalized,
    title: v.title || old?.title || normalized.url,
    enabled: v.enabled,
    goalId: v.goalId,
    updatedAt: now,
    updatedBy: deviceId(),
    ...(changed ? { contentHash: null, etag: null, lastModified: null, lastFetchedAt: null } : {})
  }
  if (old) db.update(feeds).set(row).where(eq(feeds.id, id)).run()
  else
    db.insert(feeds)
      .values({ ...row, id, createdAt: now })
      .run()
  audit({ caller: 'app', tool: 'discover.feedSave', level: 'write', status: 'ok', summary: 'Subscription settings saved' })
  if (v.enabled) enqueue('discover.feed', { id }, { dedupeKey: `discover.feed:${id}` })
  discoverChanged()
  return listFeeds().find((f) => f.id === id)!
}
export function removeFeed(id: string, options: { clearCache?: boolean; afterCommit?: (effect: () => void) => void } = {}): void {
  for (const job of getDb().select().from(jobs).where(and(eq(jobs.kind, 'discover.feed'), sql`${jobs.status} IN ('running','queued')`)).all())
    if (JSON.parse(job.payload).id === id) cancelJob(job.id, options.afterCommit)
  if (options.clearCache) getDb().delete(feedItems).where(and(eq(feedItems.feedId, id), isNull(feedItems.inboxId), sql`${feedItems.status} NOT IN ('saved','later')`)).run()
  getDb()
    .update(feeds)
    .set({ deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId(), enabled: false })
    .where(eq(feeds.id, id))
    .run()
  discoverChanged()
}
export function upsertCandidate(item: ParsedItem, feedId: string | null, origin: 'feed' | 'search', reset = false): string {
  const db = getDb(),
    old = db.select().from(feedItems).where(eq(feedItems.url, item.url)).get(),
    now = Date.now(),
    sync = { updatedAt: now, updatedBy: deviceId() }
  if (old) {
    if (reset) {
      if (old.inboxId)
        db.update(inboxItems)
          .set({ status: 'dismissed', ...sync })
          .where(eq(inboxItems.id, old.inboxId))
          .run()
      db.update(feedItems)
        .set({
          ...item,
          feedId,
          fetchedAt: now,
          status: 'new',
          score: null,
          related: '[]',
          reason: null,
          gap: null,
          minutes: null,
          // 页面刷新不会返还已投递名额；再次入选时由投递流程更新日期。
          pickedAt: old.pickedAt,
          laterAt: null,
          inboxId: null,
          ...sync
        })
        .where(eq(feedItems.id, old.id))
        .run()
      emit('inbox:changed', {})
    }
    return old.id
  }
  const id = newId()
  db.insert(feedItems)
    .values({ ...item, id, feedId, origin, fetchedAt: now, createdAt: now, ...sync })
    .run()
  return id
}
const fetching = new Map<string, Promise<void>>()
export function refreshFeed(id: string, signal?: AbortSignal): Promise<void> {
  const existing = fetching.get(id)
  if (existing) return existing
  const promise = doRefresh(id, signal).finally(() => fetching.delete(id))
  fetching.set(id, promise)
  return promise
}
async function doRefresh(id: string, signal?: AbortSignal): Promise<void> {
  const db = getDb(),
    f = db.select().from(feeds).where(eq(feeds.id, id)).get()
  if (!f || f.deletedAt || !f.enabled) return
  const valid = (): boolean => {
    signal?.throwIfAborted()
    const current = db.select().from(feeds).where(eq(feeds.id, id)).get()
    return !!current && !current.deletedAt && current.enabled && current.url === f.url && current.kind === f.kind
  }
  try {
    checkDiscoverUrl(f.url)
    let url = f.url
    if (f.kind === 'youtube' && !url.includes('/feeds/videos.xml')) {
      const r = await externalFetch(url, { validateUrl: checkDiscoverUrl, signal })
      if (r.status !== 200) throw new Error('Channel unavailable')
      const { document } = parseHTML(r.text)
      const channel =
        document.querySelector('meta[itemprop="channelId"]')?.getAttribute('content') ??
        /"channelId"\s*:\s*"(UC[\w-]{22})"/.exec(r.text)?.[1]
      if (!channel || !/^UC[\w-]{22}$/.test(channel)) throw new Error('Channel ID unavailable')
      url = normalizeFeed(channel).url
    }
    if (f.kind === 'web') {
      const page = await fetchWebText(url, 'html', signal),
        hash = WEB_HASH_PREFIX + createHash('sha256').update(page.text).digest('hex')
      if (!valid()) return
      if (f.contentHash?.startsWith(WEB_HASH_PREFIX) && f.contentHash !== hash)
        upsertCandidate(
          {
            url,
            title: page.title,
            summary: page.text.slice(0, 4000),
            author: null,
            publishedAt: Date.now(),
            audioUrl: null,
            pdfUrl: null
          },
          id,
          'feed',
          true
        )
      db.update(feeds).set({ contentHash: hash, lastFetchedAt: Date.now(), error: null }).where(eq(feeds.id, id)).run()
    } else {
      const r = await externalFetch(url, {
        headers: { ...(f.etag ? { 'If-None-Match': f.etag } : {}), ...(f.lastModified ? { 'If-Modified-Since': f.lastModified } : {}) },
        validateUrl: checkDiscoverUrl,
        signal
      })
      if (!valid()) return
      if (r.status === 304) db.update(feeds).set({ lastFetchedAt: Date.now(), error: null }).where(eq(feeds.id, id)).run()
      else {
        if (r.status !== 200) throw new Error('Feed unavailable')
        // 普通网页地址可自动识别，首次建立哈希基线，不把旧正文当新更新。
        if (/text\/html/i.test(r.headers.get('content-type') ?? '') || /^\s*<!doctype html/i.test(r.text)) {
          const page = await fetchWebText(url, 'html', signal)
          if (!valid()) return
          db.update(feeds)
            .set({
              kind: 'web',
              title: page.title,
              contentHash: WEB_HASH_PREFIX + createHash('sha256').update(page.text).digest('hex'),
              lastFetchedAt: Date.now(),
              error: null
            })
            .where(eq(feeds.id, id))
            .run()
        } else {
          const parsed = parseFeed(r.text, url)
          db.transaction(() => {
            parsed.items.forEach((item) => {
              checkDiscoverUrl(item.url)
              upsertCandidate(item, id, 'feed')
            })
            db.update(feeds)
              .set({
                url,
                title: f.title === f.url ? parsed.title : f.title,
                kind: ['arxiv', 'youtube', 'podcast'].includes(f.kind)
                  ? f.kind
                  : parsed.items.some((i) => i.audioUrl)
                    ? 'podcast'
                    : parsed.kind,
                lastFetchedAt: Date.now(),
                etag: r.headers.get('etag'),
                lastModified: r.headers.get('last-modified'),
                error: null
              })
              .where(eq(feeds.id, id))
              .run()
          })
        }
      }
    }
    audit({ caller: 'job', tool: 'discover.feed', level: 'write', status: 'ok', summary: 'Subscription refreshed' })
  } catch {
    if (!signal?.aborted && valid())
      db.update(feeds)
        .set({
          lastFetchedAt: Date.now(),
          error: tr('抓取失败，请检查订阅地址和网络', 'Fetch failed; check the subscription address and network')
        })
        .where(eq(feeds.id, id))
        .run()
  } finally {
    discoverChanged()
  }
}
export function checkFeeds(now = Date.now()): void {
  for (const f of listFeeds())
    if (f.enabled && (!f.lastFetchedAt || now - f.lastFetchedAt >= 3 * 3600000))
      enqueue('discover.feed', { id: f.id }, { dedupeKey: `discover.feed:${f.id}` })
}
export function registerFeedJob(): void {
  registerJobKind<{ id: string }>('discover.feed', {
    title: () => tr('刷新订阅源', 'Refresh subscription'),
    maxAttempts: 1,
    run: ({ id }, ctx) => refreshFeed(id, ctx.signal)
  })
}
