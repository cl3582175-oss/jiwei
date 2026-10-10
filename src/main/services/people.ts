import { voiceText } from './voiceMessages'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { getDb } from '../db'
import { people, recordingSpeakers, voiceprints, sourceSegments, sources, recordings, hotwordCorrections } from '../db/schema'
import { newId } from '../lib/ids'
import { randomUUID } from 'crypto'
import { getProfileDb, profileDb } from '../db/profile'
import { emit } from '../events'
import { requestIndex } from './ai/indexer'
import { hashText } from '../lib/derive'
import { listSegments } from './segments'
import { centroid, matchPerson, VOICEPRINT_MODEL, type VoiceCue } from '../lib/voiceprint'
import {
  PersonInput,
  SpeakerChoice,
  SpeakerLabel,
  rewriteSpeakerText,
  transcriptExport,
  transcriptTime,
  type Person,
  type RecordingSpeaker
} from '@shared/recording'

const toBlob = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer)
function fromBlob(b: Buffer | null, dim?: number): number[] {
  if (!b || b.length % 4 || (dim !== undefined && b.length !== dim * 4)) return []
  const v = Array.from(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
  return v.length > 1 && v.length <= 4096 && v.every(Number.isFinite) ? v : []
}
export function listPeople(): Person[] {
  const prints = getProfileDb().select().from(voiceprints).where(eq(voiceprints.model, VOICEPRINT_MODEL)).all()
  return getProfileDb()
    .select()
    .from(people)
    .where(isNull(people.deletedAt))
    .all()
    .map((p) => ({ id: p.id, name: p.name, isMe: p.isMe, note: p.note, voiceprints: prints.filter((v) => v.personId === p.id).length }))
}
export function savePerson(input: z.infer<typeof PersonInput>, id?: string): Person {
  input = PersonInput.parse(input)
  const db = getProfileDb(),
    now = Date.now(),
    personId = id ?? newId()
  if (id && !listPeople().some((p) => p.id === id)) throw new Error(voiceText('missingPerson'))
  db.transaction((tx) => {
    if (input.isMe) tx.update(people).set({ isMe: false, updatedAt: now }).where(eq(people.isMe, true)).run()
    tx.insert(people)
      .values({ id: personId, ...input, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: people.id, set: { ...input, updatedAt: now } })
      .run()
  })
  if (id) reconcilePeopleReferences()
  emit('people:changed', undefined)
  requestIndex()
  return listPeople().find((p) => p.id === personId)!
}
/** 私人身份改名/合并可能发生在另一个知识库。打开知识库时按当前个人身份修复其引用。 */
export function reconcilePeopleReferences(): void {
  const known = getProfileDb().select().from(people).all(),
    db = getDb()
  const resolve = (id: string): typeof people.$inferSelect | undefined => {
    const visited = new Set<string>()
    let person = known.find((p) => p.id === id)
    while (person?.mergedInto && !visited.has(person.id)) {
      visited.add(person.id)
      person = known.find((p) => p.id === person!.mergedInto)
    }
    return person && !person.deletedAt ? person : undefined
  }
  const changed = new Set<string>()
  db.transaction((tx) => {
    for (const s of tx.select().from(sourceSegments).where(eq(sourceSegments.kind, 'transcript')).all()) {
      const locator = JSON.parse(s.locator) as Record<string, unknown>
      if (typeof locator.personId !== 'string' || !SpeakerLabel.safeParse(locator.speaker).success) continue
      // 共享知识库可带已确认姓名，但接收者没有原作者的个人档案。未知引用不等于删除。
      if (!known.some((p) => p.id === locator.personId)) continue
      const person = resolve(locator.personId),
        text = rewriteSpeakerText(s.text, String(locator.speaker), person?.name ?? null)
      if (person?.id === locator.personId && text === s.text) continue
      if (person) locator.personId = person.id
      else delete locator.personId
      tx.update(sourceSegments)
        .set({ text, hash: hashText(s.kind, text), locator: JSON.stringify(locator), updatedAt: Date.now() })
        .where(eq(sourceSegments.id, s.id))
        .run()
      changed.add(s.sourceId)
    }
    for (const r of tx.select().from(recordings).all()) {
      const participants = JSON.stringify([
        ...new Set(
          (JSON.parse(r.participants) as string[])
            .map((id) => (known.some((p) => p.id === id) ? resolve(id)?.id : id))
            .filter((id): id is string => !!id)
        )
      ])
      if (participants !== r.participants)
        tx.update(recordings).set({ participants, updatedAt: Date.now() }).where(eq(recordings.id, r.id)).run()
    }
  })
  for (const sourceId of changed) emit('segments:changed', { sourceId })
  if (changed.size) requestIndex()
}

/** 清除代际持久化，应用退出/自动重试后，旧声纹任务同样不能恢复向量。 */
const VOICE_EPOCH_KEY = 'voiceprint.clear-epoch'
export function voiceprintEpoch(): string {
  const row = profileDb().prepare('SELECT value FROM meta WHERE key=?').get(VOICE_EPOCH_KEY) as { value: string } | undefined
  return row?.value ?? 'initial'
}
function invalidateVoiceprintWork(): void {
  profileDb()
    .prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(VOICE_EPOCH_KEY, randomUUID())
}
function trimPrints(personId: string): void {
  const excess = getProfileDb()
    .select()
    .from(voiceprints)
    .where(eq(voiceprints.personId, personId))
    .orderBy(desc(voiceprints.createdAt))
    .all()
    .slice(10)
  for (const row of excess) getProfileDb().delete(voiceprints).where(eq(voiceprints.id, row.id)).run()
}
export function addVoiceprint(personId: string, embedding: number[], sourceId: string | null): void {
  const clean = centroid([{ embedding, duration: 1 }])
  if (!listPeople().some((p) => p.id === personId) || !clean.some((v) => v !== 0)) throw new Error(voiceText('invalidPrint'))
  getProfileDb()
    .insert(voiceprints)
    .values({
      id: newId(),
      personId,
      embedding: toBlob(clean),
      dim: clean.length,
      model: VOICEPRINT_MODEL,
      sourceId,
      createdAt: Date.now()
    })
    .run()
  trimPrints(personId)
  emit('people:changed', undefined)
}
export function removePerson(id: string): void {
  getProfileDb().transaction((tx) => {
    invalidateVoiceprintWork()
    tx.delete(voiceprints).where(eq(voiceprints.personId, id)).run()
    tx.update(recordingSpeakers).set({ personId: null, centroid: null }).where(eq(recordingSpeakers.personId, id)).run()
    tx.update(people).set({ deletedAt: Date.now(), isMe: false }).where(eq(people.id, id)).run()
  })
  reconcilePeopleReferences()
  emit('people:changed', undefined)
  requestIndex()
}
export function mergePeople(from: string, to: string): void {
  const target = listPeople().find((p) => p.id === to),
    source = listPeople().find((p) => p.id === from)
  if (!target || !source || from === to) throw new Error(voiceText('invalidMerge'))
  getProfileDb().transaction((tx) => {
    invalidateVoiceprintWork()
    tx.update(voiceprints).set({ personId: to }).where(eq(voiceprints.personId, from)).run()
    tx.update(recordingSpeakers).set({ personId: to }).where(eq(recordingSpeakers.personId, from)).run()
    tx.update(people).set({ deletedAt: Date.now(), isMe: false, mergedInto: to }).where(eq(people.id, from)).run()
    if (source.isMe) tx.update(people).set({ isMe: true }).where(eq(people.id, to)).run()
    trimPrints(to)
  })
  reconcilePeopleReferences()
  emit('people:changed', undefined)
  requestIndex()
}
export function clearVoiceprints(removeNames: boolean, personId?: string): void {
  const db = getProfileDb()
  db.transaction((tx) => {
    invalidateVoiceprintWork()
    if (personId) {
      tx.delete(voiceprints).where(eq(voiceprints.personId, personId)).run()
      tx.update(recordingSpeakers).set({ centroid: null }).where(eq(recordingSpeakers.personId, personId)).run()
    } else {
      tx.delete(voiceprints).run()
      tx.update(recordingSpeakers).set({ centroid: null }).run()
    }
    if (removeNames) {
      tx.update(people)
        .set({ deletedAt: Date.now(), isMe: false })
        .where(personId ? eq(people.id, personId) : undefined)
        .run()
      tx.update(recordingSpeakers)
        .set({ personId: null, centroid: null })
        .where(personId ? eq(recordingSpeakers.personId, personId) : undefined)
        .run()
    }
  })
  if (removeNames) reconcilePeopleReferences()
  emit('people:changed', undefined)
}
export function listSpeakers(sourceId: string): RecordingSpeaker[] {
  const known = listPeople(),
    segs = listSegments(sourceId)
  return getProfileDb()
    .select()
    .from(recordingSpeakers)
    .where(eq(recordingSpeakers.sourceId, sourceId))
    .all()
    .map((s) => {
      const cues = segs.filter((c) => c.locator.speaker === s.label),
        clear = cues
          .filter((c) => !c.locator.uncertain)
          .sort((a, b) => {
            const ta = transcriptTime(a.locator),
              tb = transcriptTime(b.locator)
            return (tb ? tb[1] - tb[0] : 0) - (ta ? ta[1] - ta[0] : 0)
          }),
        best = transcriptTime((clear[0] ?? cues[0])?.locator ?? {})
      const total = cues.reduce((n, c) => {
        const tm = transcriptTime(c.locator)
        return n + (tm ? tm[1] - tm[0] : 0)
      }, 0)
      const mic = cues
        .filter((c) => c.locator.track === 'mic')
        .reduce((n, c) => {
          const tm = transcriptTime(c.locator)
          return n + (tm ? tm[1] - tm[0] : 0)
        }, 0)
      return {
        label: s.label,
        personId: s.personId,
        name: known.find((p) => p.id === s.personId)?.name ?? null,
        origin: s.origin,
        confidence: s.confidence,
        hasCentroid: !!s.centroid,
        maybeMe: total > 0 && mic / total >= 0.8,
        sampleStart: best?.[0] ?? 0,
        sampleEnd: Math.min(best?.[1] ?? 0, (best?.[0] ?? 0) + 5),
        skipped: s.skipped
      }
    })
}
export function confirmSpeaker(input: z.infer<typeof SpeakerChoice>): void {
  input = SpeakerChoice.parse(input)
  const db = getDb(),
    source = db.select().from(sources).where(eq(sources.id, input.sourceId)).get()
  if (!source || source.deletedAt) throw new Error(voiceText('missingSource'))
  const person = input.personId ? listPeople().find((p) => p.id === input.personId) : null
  if (input.personId && !person) throw new Error(voiceText('missingPerson'))
  const existing = getProfileDb()
    .select()
    .from(recordingSpeakers)
    .where(and(eq(recordingSpeakers.sourceId, input.sourceId), eq(recordingSpeakers.label, input.label)))
    .get()
  if (!existing) throw new Error(voiceText('missingSpeaker'))
  const segments = listSegments(input.sourceId).filter((s) =>
    input.segmentId ? s.id === input.segmentId : s.locator.speaker === input.label
  )
  if (!segments.length) throw new Error(voiceText('missingSegment'))
  db.transaction((tx) => {
    if (!input.segmentId) {
      getProfileDb()
        .update(recordingSpeakers)
        .set({ personId: person?.id ?? null, origin: 'user', skipped: !person })
        .where(and(eq(recordingSpeakers.sourceId, input.sourceId), eq(recordingSpeakers.label, input.label)))
        .run()
      const vector = fromBlob(existing.centroid)
      if (person && vector.length) addVoiceprint(person.id, vector, input.sourceId)
    }
    for (const seg of segments) {
      const locator = {
        ...seg.locator,
        ...(input.segmentId ? { edited: true } : {}),
        speaker: input.label,
        ...(person ? { personId: person.id } : {})
      }
      if (!person) delete locator.personId
      const text = rewriteSpeakerText(seg.text, input.label, person?.name ?? null)
      tx.update(sourceSegments)
        .set({ text, hash: hashText(seg.kind, text), locator: JSON.stringify(locator), updatedAt: Date.now() })
        .where(eq(sourceSegments.id, seg.id))
        .run()
    }
  })
  emit('segments:changed', { sourceId: input.sourceId })
  emit('people:changed', undefined)
  requestIndex()
}
/** 自动认人只读已登记声纹；用户确认才登记新声纹，防止误匹配污染声纹库。 */
export function identifySpeakers(
  cues: VoiceCue[],
  participants?: string[]
): { cues: VoiceCue[]; speakers: { label: string; personId: string | null; embedding: number[]; confidence: number | null }[] } {
  const prints = getProfileDb().select().from(voiceprints).where(eq(voiceprints.model, VOICEPRINT_MODEL)).all()
  const persons = listPeople().map((p) => ({
    ...p,
    embeddings: prints
      .filter((v) => v.personId === p.id)
      .map((v) => fromBlob(v.embedding, v.dim))
      .filter((v) => v.length)
  }))
  const speakers = [...new Set(cues.map((c) => c.speaker).filter((s): s is string => !!s))].map((label) => {
    const embedding = centroid(
      cues
        .filter((c) => c.speaker === label && c.embedding && c.end - c.start >= 1 && !c.uncertain)
        .map((c) => ({ embedding: c.embedding!, duration: c.end - c.start }))
    )
    const match = embedding.length
      ? matchPerson(
          embedding,
          persons.filter((p) => p.embeddings.every((v) => v.length === embedding.length)),
          participants
        )
      : null
    return { label, embedding, personId: match?.personId ?? null, confidence: match?.confidence ?? null }
  })
  return {
    speakers,
    cues: cues.map((c) => {
      const s = speakers.find((s) => s.label === c.speaker),
        p = persons.find((p) => p.id === s?.personId)
      return { ...c, ...(p ? { personId: p.id, personName: p.name } : {}) }
    })
  }
}
export function saveRecordingSpeakers(sourceId: string, rows: ReturnType<typeof identifySpeakers>['speakers']): void {
  getProfileDb().transaction((tx) => {
    tx.delete(recordingSpeakers).where(eq(recordingSpeakers.sourceId, sourceId)).run()
    for (const s of rows)
      tx.insert(recordingSpeakers)
        .values({
          sourceId,
          label: SpeakerLabel.parse(s.label),
          personId: s.personId,
          confidence: s.confidence,
          centroid: s.embedding.length ? toBlob(s.embedding) : null,
          origin: 'auto'
        })
        .run()
  })
}
export function removeRecordingSpeakers(sourceId: string): void {
  getProfileDb().delete(recordingSpeakers).where(eq(recordingSpeakers.sourceId, sourceId)).run()
}
export const listCorrections = () =>
  getDb().select().from(hotwordCorrections).orderBy(desc(hotwordCorrections.lastUsedAt), desc(hotwordCorrections.count)).all()
export const removeCorrection = (id: string): void => {
  getDb().delete(hotwordCorrections).where(eq(hotwordCorrections.id, id)).run()
}
export async function exportTranscript(win: BrowserWindow | null, sourceId: string, format: 'md' | 'srt' | 'txt'): Promise<string | null> {
  if (!win) return null
  const source = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
  if (!source || source.deletedAt) throw new Error(voiceText('missingSource'))
  const result = await dialog.showSaveDialog(win, {
    defaultPath: `${source.title.replace(/[\\/:*?"<>|]/g, '_')}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(
    result.filePath,
    transcriptExport(
      listSegments(sourceId).filter((s) => s.kind === 'transcript'),
      format
    ),
    'utf8'
  )
  return result.filePath
}
