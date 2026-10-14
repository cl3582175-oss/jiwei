import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db'
import { derivations, recordings, sourceSegments } from '../db/schema'
import { listPeople } from './people'
import { listActions } from './reflection'
import { getSource } from './sources'
import type { LensResult, PersonPageData } from '@shared/lens'
import { transcriptRevision } from './recordingContext'

export function personPage(id: string): PersonPageData {
  const db = getDb(),
    ids = new Set<string>()
  for (const s of db.select().from(sourceSegments).where(eq(sourceSegments.kind, 'transcript')).all()) {
    try {
      if ((JSON.parse(s.locator) as { personId?: string }).personId === id) ids.add(s.sourceId)
    } catch {
      /* 损坏定位不猜人 */
    }
  }
  for (const r of db.select().from(recordings).where(isNull(recordings.deletedAt)).all())
    if (r.sourceId && (JSON.parse(r.participants) as string[]).includes(id)) ids.add(r.sourceId)
  const actions = listActions().filter((a) => a.ownerPersonId === id)
  const viewpoints: PersonPageData['viewpoints'] = []
  const versions = new Set<string>()
  for (const d of db
    .select()
    .from(derivations)
    .where(and(eq(derivations.status, 'ready'), isNull(derivations.deletedAt)))
    .orderBy(desc(derivations.createdAt))
    .all()) {
    const source = getSource(d.sourceId)
    if (
      !d.result ||
      !source ||
      source.deletedAt ||
      source.space === 'attachment' ||
      d.transcriptRevision !== transcriptRevision(d.sourceId)
    )
      continue
    const version = JSON.stringify([d.sourceId, d.lens, d.params])
    if (versions.has(version)) continue
    versions.add(version)
    const result = JSON.parse(d.result) as LensResult
    for (const item of result.items) {
      if (!['agenda', 'decision', 'qa', 'viewpoint', 'item', 'paragraph', 'idea'].includes(item.category)) continue
      if (item.speakerPersonId !== id && !item.evidence.every((ref) => result.sentences.find((s) => s.ref === ref)?.personId === id))
        continue
      ids.add(d.sourceId)
      viewpoints.push({
        derivationId: d.id,
        sourceId: d.sourceId,
        title: source.title,
        item,
        t: result.sentences.find((s) => s.ref === item.evidence[0])?.start ?? 0
      })
      if (viewpoints.length >= 100) break
    }
    if (viewpoints.length >= 100) break
  }
  return {
    person: listPeople().find((p) => p.id === id) ?? null,
    sources: [...ids]
      .map((id) => getSource(id))
      .filter((s): s is NonNullable<typeof s> => !!s && !s.deletedAt && s.space !== 'attachment')
      .sort((a, b) => b.createdAt - a.createdAt),
    actions,
    viewpoints
  }
}
