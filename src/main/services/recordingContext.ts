import { and, eq, isNull } from 'drizzle-orm'
import { createHash } from 'crypto'
import { getDb } from '../db'
import { recordings, sources } from '../db/schema'
import { newId } from '../lib/ids'
import { mossTranscriptRevision } from '../lib/moss'
import { deviceId } from './device'
import { listSegments } from './segments'
import { listPeople } from './people'
import { speakerBody, transcriptTime } from '@shared/recording'
import type { EvidenceSentence } from '@shared/lens'
import { getSettings } from './settings'
import zh from '../../renderer/src/i18n/zh-CN'
import en from '../../renderer/src/i18n/en'

export const lensMessage = (key: keyof typeof zh.lens.errors): string =>
  (getSettings().language.startsWith('zh') ? zh : en).lens.errors[key]
export const transcriptRevision = (sourceId: string): string =>
  createHash('sha256')
    .update(mossTranscriptRevision(listSegments(sourceId)))
    .digest('hex')
/** 导入音视频也拥有场景/系列元数据，不移动原资产，也不假造录音文件。 */
export function ensureRecordingMetadata(sourceId: string): typeof recordings.$inferSelect {
  const db = getDb(),
    existing = db
      .select()
      .from(recordings)
      .where(and(eq(recordings.sourceId, sourceId), isNull(recordings.deletedAt)))
      .get()
  if (existing) return existing
  const s = db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
    .get()
  if (!s || !['audio', 'video', 'recording', 'web'].includes(s.kind) || !listSegments(sourceId).some((s) => s.kind === 'transcript'))
    throw new Error(lensMessage('transcript'))
  const now = Date.now(),
    id = newId()
  db.insert(recordings)
    .values({
      id,
      sourceId,
      scene: 'unspecified',
      status: 'ready',
      tracks: '[]',
      startedAt: s.publishedAt ?? s.accessedAt,
      localOnly: s.aiExcluded,
      createdAt: now,
      updatedAt: now,
      updatedBy: deviceId()
    })
    .run()
  return db.select().from(recordings).where(eq(recordings.id, id)).get()!
}
export function requireLensCloud(sourceId: string, identity = getDb()): void {
  if (getDb() !== identity) throw new Error(lensMessage('changed'))
  const source = identity.select().from(sources).where(eq(sources.id, sourceId)).get()
  if (!source || source.deletedAt) throw new Error(lensMessage('transcript'))
  if (source.aiExcluded) throw new Error(lensMessage('local'))
}
export function lensSentences(sourceId: string): EvidenceSentence[] {
  const people = listPeople()
  return listSegments(sourceId)
    .filter((s) => s.kind === 'transcript')
    .flatMap((s, i) => {
      const time = transcriptTime(s.locator)
      if (!time) return []
      const speaker = typeof s.locator.speaker === 'string' ? s.locator.speaker : 'S01',
        personId = typeof s.locator.personId === 'string' ? s.locator.personId : null
      const name =
        people.find((p) => p.id === personId)?.name ??
        (personId ? /^［([^］]+)］/.exec(s.text)?.[1] : null) ??
        `说话人 ${Number(speaker.slice(1)) || 1}`
      return [{ ref: `u${i + 1}`, segmentId: s.id, start: time[0], end: time[1], speaker, name, personId, text: speakerBody(s.text) }]
    })
}
