import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DiscoverAction, FeedItem, DiscoveryScore } from '@shared/discover'
import { DiscoverAct } from '@shared/discover'
import { getDb } from '../../db'
import { feedItems, discoverFeedback, inboxItems, sources, meta } from '../../db/schema'
import { dayStart, localDay } from '@shared/plan'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { emit } from '../../events'
import { create } from '../inbox'
import { addUrl, importContent } from '../sources'
import { externalFetch } from '../externalFetch'
import { audit } from '../agent/audit'
import { tr } from '../../lib/messages'
import { checkDiscoverUrl, discoverChanged } from './feeds'
import { allowedRelated } from './context'
import { privacyFingerprint } from '../ai/privacy'

type Delivery = { id: string; url: string; diverse: boolean }
const deliveryKey = (now: number): string => `discover.deliveries:${localDay(now)}`
/** 已投递额度独立于卡片的状态、正文刷新或删除，且与写入卡片处在同一知识库事务。 */
export function dailyDeliveries(now = Date.now()): Delivery[] {
  const db = getDb(),
    stored: Delivery[] = JSON.parse(db.select().from(meta).where(eq(meta.key, deliveryKey(now))).get()?.value ?? '[]'),
    seen = new Set(stored.map((i) => i.id))
  // 补齐升级前已有的当天投递，保存、稍后和删除都不能返还额度。
  for (const i of db.select().from(feedItems).all())
    if (!i.remedyId && i.pickedAt !== null && i.pickedAt >= dayStart(now) && i.pickedAt <= now && !seen.has(i.id)) {
      stored.push({ id: i.id, url: i.url, diverse: !!(i.score && (JSON.parse(i.score) as DiscoveryScore).diverse) })
      seen.add(i.id)
    }
  return stored
}
export function scoreAllowed(score: DiscoveryScore): boolean {
  return score.privacySignature === privacyFingerprint() && allowedRelated(score.related).length === score.related.length
}

export function knowledgeTarget(url: string): { type: 'note' | 'source'; id: string } | null {
  const match = /^jiwei:\/\/(note|source)\/([\w-]+)$/.exec(url)
  if (!match) return null
  const ref = { type: match[1] as 'note' | 'source', id: match[2] }
  if (!allowedRelated([ref]).length) throw new Error('Knowledge resource is excluded or unavailable')
  return ref
}

export function toItem(r: typeof feedItems.$inferSelect): FeedItem {
  return { ...r, score: r.score ? JSON.parse(r.score) : null, related: allowedRelated(JSON.parse(r.related)) }
}
export function items(all = false): FeedItem[] {
  return getDb()
    .select()
    .from(feedItems)
    .where(isNull(feedItems.deletedAt))
    .orderBy(desc(feedItems.pickedAt), desc(feedItems.fetchedAt))
    .all()
    .filter((r) => all || r.status === 'picked')
    .map(toItem)
}
export function publishPick(id: string, score: DiscoveryScore, remedyId?: string, countDelivery = !remedyId): string {
  const db = getDb(),
    r = db.select().from(feedItems).where(eq(feedItems.id, id)).get()
  if (!r || r.deletedAt) throw new Error('Candidate not found')
  if (!scoreAllowed(score)) throw new Error('Recommendation privacy context changed')
  if (!knowledgeTarget(r.url)) checkDiscoverUrl(r.url)
  const related = allowedRelated(score.related),
    now = Date.now(),
    text = `${r.title}\n${r.url}\n${tr('为什么推荐给你', 'Why this is for you')}: ${score.reason}\n${score.gap}\n${related.map((ref) => `${ref.type}:${ref.id}`).join(' · ')}\n${score.minutes} ${tr('分钟', 'minutes')}`
  let inboxId = r.inboxId
  db.transaction(() => {
    if (countDelivery) {
      const delivered = dailyDeliveries(now)
      if (!delivered.some((i) => i.id === id)) delivered.push({ id, url: r.url, diverse: score.diverse })
      const key = deliveryKey(now), value = JSON.stringify(delivered)
      db.insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run()
    }
    const old = inboxId ? db.select().from(inboxItems).where(eq(inboxItems.id, inboxId)).get() : null
    if (!old || old.deletedAt) inboxId = create({ kind: 'pick', text, origin: { itemId: id, ...(remedyId ? { remedyId } : {}) } }).id
    else db.update(inboxItems).set({ text, status: 'new', updatedAt: now, updatedBy: deviceId() }).where(eq(inboxItems.id, inboxId!)).run()
    db.update(feedItems)
      .set({
        status: 'picked',
        score: JSON.stringify(score),
        reason: score.reason,
        gap: score.gap,
        minutes: score.minutes,
        related: JSON.stringify(related),
        pickedAt: countDelivery ? now : (r.pickedAt ?? now),
        inboxId,
        remedyId: remedyId ?? r.remedyId,
        laterAt: null,
        updatedAt: now,
        updatedBy: deviceId()
      })
      .where(eq(feedItems.id, id))
      .run()
  })
  audit({
    caller: 'job',
    tool: 'discover.pick',
    level: 'write',
    status: 'ok',
    summary: remedyId ? 'Mistake remedy saved to picks' : 'Discovery saved to picks'
  })
  discoverChanged()
  emit('inbox:changed', {})
  return inboxId!
}
const saving = new Set<string>()
export async function act(
  input: DiscoverAction
): Promise<{ url: string; sourceId?: string; target?: { type: 'note' | 'source'; id: string } }> {
  const v = DiscoverAct.parse(input),
    db = getDb(),
    item = db.select().from(feedItems).where(eq(feedItems.id, v.itemId)).get()
  if (!item || item.deletedAt || !['picked', 'later'].includes(item.status)) throw new Error('Pick is no longer active')
  let sourceId: string | undefined
  const target = knowledgeTarget(item.url)
  if ((v.action === 'read' || v.action === 'save') && !target) checkDiscoverUrl(item.url)
  if (v.action === 'save') {
    if (saving.has(item.id)) throw new Error('Save already in progress')
    saving.add(item.id)
    try {
      const existing = db
        .select()
        .from(sources)
        .where(and(eq(sources.url, item.pdfUrl ?? item.url), isNull(sources.deletedAt)))
        .get()
      if (existing) sourceId = existing.id
      else if (target?.type === 'source') sourceId = target.id
      else if (target)
        sourceId = (
          await importContent('remedy.txt', 'text/plain', new TextEncoder().encode(`${item.title}\n${item.summary}`), {
            title: item.title,
            url: item.url
          })
        ).id
      else if (item.pdfUrl) {
        checkDiscoverUrl(item.pdfUrl)
        const r = await externalFetch(item.pdfUrl, { maxBytes: 40 * 1024 * 1024, validateUrl: checkDiscoverUrl })
        if (r.status !== 200 || new TextDecoder().decode(r.bytes.subarray(0, 5)) !== '%PDF-')
          throw new Error(tr('下载未返回 PDF，请稍后重试', 'Download did not return a PDF; try again later'))
        sourceId = (await importContent('discovery.pdf', 'application/pdf', r.bytes, { title: item.title, url: item.pdfUrl })).id
      } else sourceId = addUrl(item.url, item.title).id
    } finally {
      saving.delete(item.id)
    }
  }
  const now = Date.now(),
    status = v.action === 'save' ? 'saved' : v.action === 'later' ? 'later' : v.action === 'dismiss' ? 'dismissed' : item.status
  db.transaction(() => {
    db.insert(discoverFeedback)
      .values({
        id: newId(),
        itemId: item.id,
        action: v.action,
        at: now,
        topic: `${item.title}\n${item.summary.slice(0, 200)}`,
        reason: v.reason ?? null
      })
      .run()
    db.update(feedItems)
      .set({ status, laterAt: v.action === 'later' ? now + 3 * 86400000 : item.laterAt, updatedAt: now, updatedBy: deviceId() })
      .where(eq(feedItems.id, item.id))
      .run()
    if (item.inboxId && v.action !== 'read')
      db.update(inboxItems)
        .set({ status: v.action === 'save' ? 'filed' : 'dismissed', updatedAt: now, updatedBy: deviceId() })
        .where(eq(inboxItems.id, item.inboxId))
        .run()
  })
  audit({ caller: 'app', tool: `discover.${v.action}`, level: 'write', status: 'ok', summary: 'Pick feedback saved' })
  discoverChanged()
  emit('inbox:changed', {})
  if (sourceId) emit('sources:changed', { id: sourceId })
  return { url: item.url, ...(sourceId ? { sourceId } : {}), ...(target ? { target } : {}) }
}
export function restoreLater(now = Date.now()): void {
  for (const r of getDb()
    .select()
    .from(feedItems)
    .where(and(eq(feedItems.status, 'later'), isNull(feedItems.deletedAt)))
    .all())
    if (r.laterAt !== null && r.laterAt <= now && r.score && scoreAllowed(JSON.parse(r.score)))
      publishPick(r.id, JSON.parse(r.score), r.remedyId ?? undefined, false)
}
