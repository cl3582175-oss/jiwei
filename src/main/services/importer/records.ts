import { eq, like } from 'drizzle-orm'
import { getDb } from '../../db'
import { meta } from '../../db/schema'
import { getNote } from '../notes'
import type { ImportItem, ImportOptions, ImportRun, ImportScan } from '@shared/importer'
import type { ImportHistory, ScannedLibrary } from './scan'
import { createHash } from 'crypto'

// Temporary P1–P5 storage. Each row can be updated in the same transaction as its note.
const PREFIX = 'import.tmp.'
export interface ScanRecord {
  state: ImportScan
  paths: string[]
  library?: ScannedLibrary
  format?: 'notion'
}
export interface RunRecord {
  state: Omit<ImportRun, 'items'>
  options: ImportOptions
  rootHash: string
  folders?: Record<string, string>
}
export interface ItemRecord extends ImportItem {
  rootHash: string
  hash: string
  complete: boolean
  /** UUID checkpoint only; the note is created atomically with its completed body. */
  reservedNoteId?: string
  /** An earlier run owns this note, so undo must never trash it. */
  reusedNoteId?: string
}
export function readRecord<T>(key: string): T | null {
  const row = getDb()
    .select()
    .from(meta)
    .where(eq(meta.key, PREFIX + key))
    .get()
  return row ? (JSON.parse(row.value) as T) : null
}
export function saveRecord(key: string, value: unknown): void {
  const valueString = JSON.stringify(value)
  getDb()
    .insert(meta)
    .values({ key: PREFIX + key, value: valueString })
    .onConflictDoUpdate({ target: meta.key, set: { value: valueString } })
    .run()
}
function records<T>(prefix: string): T[] {
  return getDb()
    .select()
    .from(meta)
    .where(like(meta.key, `${PREFIX}${prefix}%`))
    .all()
    .map((r) => JSON.parse(r.value) as T)
}
export const items = (runId: string): ItemRecord[] => records<ItemRecord>(`item.${runId}.`)
export const itemKey = (runId: string, path: string): string => `item.${runId}.${createHash('sha256').update(path).digest('hex')}`
export function getRun(id: string): ImportRun {
  const run = readRecord<RunRecord>(`run.${id}`)
  if (!run) throw new Error('Import run not found')
  return {
    ...run.state,
    items: items(id)
      .filter((i) => i.complete)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ rootHash: _root, hash: _hash, complete: _complete, reservedNoteId: _reserved, reusedNoteId: _reused, ...item }) => item)
  }
}
export function listRuns(): ImportRun[] {
  return records<RunRecord>('run.')
    .sort((a, b) => b.state.createdAt - a.state.createdAt)
    .slice(0, 100)
    .map((r) => getRun(r.state.id))
}
export function importHistory(): ImportHistory[] {
  const runs = records<RunRecord>('run.')
  const active = new Set(runs.map((r) => r.state.id))
  const at = new Map(runs.map((r) => [r.state.id, r.state.createdAt]))
  const rows = getDb()
    .select()
    .from(meta)
    .where(like(meta.key, `${PREFIX}item.%`))
    .all()
    .sort((a, b) => (at.get(a.key.split('.')[3]) ?? 0) - (at.get(b.key.split('.')[3]) ?? 0) || a.key.localeCompare(b.key))
  return rows.flatMap((r) => {
    const i = JSON.parse(r.value) as ItemRecord
    if (!active.has(r.key.split('.')[3]) || !i.complete || i.status !== 'imported' || !i.noteId) return []
    const note = getNote(i.noteId)
    return note && !note.deletedAt ? [{ rootHash: i.rootHash, path: i.path, hash: i.hash, noteId: i.noteId }] : []
  })
}
