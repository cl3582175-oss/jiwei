import { and, eq, isNull } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { getDb } from '../../db'
import { notes, sources, mistakes, discoverFeedback, feedItems } from '../../db/schema'
import { feedbackAllowed } from '../../lib/pickSelection'
import { listGoals, masteryMap } from '../progress'
import { phases } from '../plan/phases'
import { listConcepts } from '../learner'
import { requireMistakeCloud } from '../mistakesPrivacy'
import { getSettings } from '../settings'
import { checkDiscoverUrl } from './feeds'

export function discoveryContext(goalId?: string) {
  const db = getDb(),
    allowedNotes = db
      .select()
      .from(notes)
      .where(and(isNull(notes.deletedAt), eq(notes.aiExcluded, false)))
      .all(),
    allowedSources = db
      .select()
      .from(sources)
      .where(and(isNull(sources.deletedAt), eq(sources.aiExcluded, false)))
      .all(),
    noteIds = new Set(allowedNotes.map((n) => n.id)),
    sourceIds = new Set(allowedSources.map((s) => s.id))
  const directions = listGoals()
    .filter((g) => g.status === 'active' && (!goalId || g.id === goalId))
    .map((g) => ({
      id: g.id,
      title: g.title,
      kind: g.kind,
      description: g.description,
      phases: phases(g.id).map((p) => ({ title: p.title, status: p.status })),
      weakNotes: masteryMap(g.id)
        .notes.filter((n) => noteIds.has(n.id) && (n.recall ?? 0) < 0.8)
        .slice(0, 20)
        .map((n) => ({ id: n.id, title: n.title, recall: n.recall }))
    }))
  const allowedMistakes = db
    .select()
    .from(mistakes)
    .where(isNull(mistakes.deletedAt))
    .all()
    .filter((m) => {
      try {
        requireMistakeCloud(m.id)
        return true
      } catch {
        return false
      }
    })
  const points = new Map<string, { concept: string; cause: string; count: number }>()
  for (const m of allowedMistakes)
    for (const concept of JSON.parse(m.concepts) as string[]) {
      const key = `${concept}:${m.cause}`
      const old = points.get(key)
      points.set(key, { concept, cause: m.cause, count: (old?.count ?? 0) + 1 })
    }
  // learner 的历史证据缺少可靠隐私来源，只输出能锚定到当前允许素材的概念名与掌握度。
  const anchor = [
    ...allowedNotes.map((n) => `${n.title}\n${n.plainText}`),
    ...directions.map((g) => `${g.title}\n${g.description ?? ''}`),
    ...points.values()
  ]
    .map((v) => (typeof v === 'string' ? v : v.concept))
    .join('\n')
    .toLocaleLowerCase()
  const concepts = listConcepts()
    .filter((c) => c.lastSeen >= Date.now() - 7 * 86400000 && anchor.includes(c.name.toLocaleLowerCase()))
    .slice(0, 30)
    .map((c) => ({ name: c.name, mastery: c.mastery }))
  const allowedFeedback = new Set([...Array.from(noteIds).map((id) => `note:${id}`), ...Array.from(sourceIds).map((id) => `source:${id}`)])
  const feedback = db
    .select()
    .from(discoverFeedback)
    .all()
    .sort((a, b) => b.at - a.at)
    .filter((f) => {
      const i = db.select().from(feedItems).where(eq(feedItems.id, f.itemId)).get()
      return i && !i.deletedAt && feedbackAllowed(i.url, allowedFeedback) && (i.url.startsWith('jiwei:') || allowedCandidate(i.url))
    })
    .slice(0, 30)
    .map(({ action, topic, reason }) => ({ action, topic, reason }))
  const facts = {
    directions,
    gaps: [...points.values()].sort((a, b) => b.count - a.count).slice(0, 30),
    concepts,
    feedback,
    known: [
      ...allowedNotes.map((n) => ({ type: 'note' as const, id: n.id, title: n.title })),
      ...allowedSources.map((s) => ({ type: 'source' as const, id: s.id, title: s.title }))
    ].slice(0, 200)
  }
  const stableFacts = {
    ...facts,
    directions: facts.directions.map((g) => ({ ...g, weakNotes: g.weakNotes.map(({ id, title }) => ({ id, title })) }))
  }
  return {
    facts,
    noteIds,
    sourceIds,
    signature: createHash('sha256')
      .update(
        JSON.stringify({
          facts: stableFacts,
          allowed: [Array.from(noteIds).sort(), Array.from(sourceIds).sort()],
          blocked: getSettings().browser?.aiBlockedSites
        })
      )
      .digest('hex')
  }
}
export function allowedRelated(refs: { type: 'note' | 'source'; id: string }[]): typeof refs {
  const db = getDb()
  return refs.filter((r) => {
    const row =
      r.type === 'note'
        ? db.select().from(notes).where(eq(notes.id, r.id)).get()
        : db.select().from(sources).where(eq(sources.id, r.id)).get()
    return row && !row.deletedAt && !row.aiExcluded
  })
}
export function allowedCandidate(url: string): boolean {
  try {
    checkDiscoverUrl(url)
    return true
  } catch {
    return false
  }
}
