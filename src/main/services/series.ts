import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { actions, categories, derivations, recordings, series, sources } from '../db/schema'
import { SeriesInput, type LensOrigin, type Series, type SeriesDetail } from '@shared/lens'
import { listActions } from './reflection'
import { getSource } from './sources'
import { newId } from '../lib/ids'
import { deviceId } from './device'
import { emit } from '../events'
import { ensureRecordingMetadata, lensMessage } from './recordingContext'

export function listSeries(): Series[] {
  return getDb()
    .select()
    .from(series)
    .where(isNull(series.deletedAt))
    .orderBy(desc(series.updatedAt))
    .all()
    .map(({ id, name, scene, categoryId }) => ({ id, name, scene, categoryId }))
}
export function saveSeries(input: z.infer<typeof SeriesInput>, id?: string): Series {
  input = SeriesInput.parse(input)
  const db = getDb(),
    now = Date.now()
  if (id && !listSeries().some((s) => s.id === id)) throw new Error(lensMessage('series'))
  if (
    input.categoryId &&
    !db
      .select()
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.kind, 'note'), isNull(categories.deletedAt)))
      .get()
  )
    throw new Error(lensMessage('note'))
  const key = id ?? newId()
  db.insert(series)
    .values({ id: key, ...input, createdAt: now, updatedAt: now, updatedBy: deviceId() })
    .onConflictDoUpdate({ target: series.id, set: { ...input, updatedAt: now, updatedBy: deviceId() } })
    .run()
  emit('series:changed', undefined)
  return listSeries().find((s) => s.id === key)!
}
export function setRecordingSeries(sourceId: string, seriesId: string | null): void {
  if (seriesId && !listSeries().some((s) => s.id === seriesId)) throw new Error(lensMessage('series'))
  const recording = ensureRecordingMetadata(sourceId)
  getDb().update(recordings).set({ seriesId, updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(recordings.id, recording.id)).run()
  emit('recording:changed', { id: recording.id })
  emit('series:changed', undefined)
}
export function seriesSourceIds(id: string, cloud = false): string[] {
  return getDb()
    .select({ id: sources.id, excluded: sources.aiExcluded })
    .from(recordings)
    .innerJoin(sources, eq(recordings.sourceId, sources.id))
    .where(and(eq(recordings.seriesId, id), isNull(recordings.deletedAt), isNull(sources.deletedAt)))
    .all()
    .filter((s) => !cloud || !s.excluded)
    .map((s) => s.id)
}
export function seriesActions(id: string, cloud = false) {
  const ids = new Set(seriesSourceIds(id, cloud))
  return listActions().filter((a) => a.origin && ids.has(a.origin.sourceId))
}
export function seriesDetail(id: string): SeriesDetail {
  const s = listSeries().find((s) => s.id === id)
  if (!s) throw new Error(lensMessage('series'))
  return {
    series: s,
    sources: seriesSourceIds(id)
      .map((id) => getSource(id))
      .filter((s): s is NonNullable<typeof s> => !!s),
    actions: seriesActions(id)
  }
}
export function seriesContext(
  id: string | null,
  sourceId: string
): {
  summaries: { sourceId: string; summary: string }[]
  actions: { id: string; title: string; ownerName: string | null; dueAt: number | null }[]
} {
  if (!id) return { summaries: [], actions: [] }
  const ids = new Set(seriesSourceIds(id, true)),
    seen = new Set<string>()
  const summaries = getDb()
    .select()
    .from(derivations)
    .where(and(eq(derivations.status, 'ready'), isNull(derivations.deletedAt)))
    .orderBy(desc(derivations.createdAt))
    .all()
    .filter((d) => {
      if (d.sourceId === sourceId || !ids.has(d.sourceId) || seen.has(d.sourceId) || !d.summary) return false
      seen.add(d.sourceId)
      return true
    })
    .slice(0, 2)
    .map((d) => ({ sourceId: d.sourceId, summary: d.summary }))
  const open = seriesActions(id, true)
    .filter((a) => a.status === 'open')
    .slice(0, 50)
    .map((a) => ({ id: a.id, title: a.title, ownerName: a.ownerName ?? null, dueAt: a.dueAt }))
  return { summaries, actions: open }
}
/** 兼容旧版本行；未知或损坏来源不能进入系列上下文。 */
export function actionSourceId(origin: string | null): string | null {
  try {
    return origin ? ((JSON.parse(origin) as LensOrigin).sourceId ?? null) : null
  } catch {
    return null
  }
}
export const actionRow = (id: string) => getDb().select().from(actions).where(eq(actions.id, id)).get()
