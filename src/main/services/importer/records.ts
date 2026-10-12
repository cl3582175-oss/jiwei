import { and, eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { importItems, importRuns, importScans } from '../../db/schema'
import { getNote } from '../notes'
import type { ImportItem, ImportOptions, ImportRun, ImportScan } from '@shared/importer'
import type { ImportHistory, ScannedLibrary } from './scan'

// 导入记录（迁移 0031）。每条记录都能和对应笔记在同一事务里写入。
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
type Key = { table: 'scan'; id: string } | { table: 'run'; id: string } | { table: 'item'; runId: string; path: string }
function parse(key: string): Key {
  const dot = key.indexOf('.')
  const table = key.slice(0, dot)
  const rest = key.slice(dot + 1)
  if (table === 'item') {
    const at = rest.indexOf('.')
    return { table, runId: rest.slice(0, at), path: rest.slice(at + 1) }
  }
  if (table === 'scan' || table === 'run') return { table, id: rest }
  throw new Error('Unknown import record')
}
export function readRecord<T>(key: string): T | null {
  const k = parse(key)
  const db = getDb()
  const row =
    k.table === 'scan'
      ? db.select({ data: importScans.data }).from(importScans).where(eq(importScans.id, k.id)).get()
      : k.table === 'run'
        ? db.select({ data: importRuns.data }).from(importRuns).where(eq(importRuns.id, k.id)).get()
        : db
            .select({ data: importItems.data })
            .from(importItems)
            .where(and(eq(importItems.runId, k.runId), eq(importItems.sourceKey, k.path)))
            .get()
  return row ? (JSON.parse(row.data) as T) : null
}
export function saveRecord(key: string, value: unknown): void {
  const k = parse(key)
  const data = JSON.stringify(value)
  const db = getDb()
  if (k.table === 'scan') {
    const createdAt = Date.now()
    db.insert(importScans).values({ id: k.id, data, createdAt }).onConflictDoUpdate({ target: importScans.id, set: { data } }).run()
  } else if (k.table === 'run') {
    const r = value as RunRecord
    const row = {
      kind: r.state.kind,
      rootLabel: r.state.label,
      rootHash: r.rootHash,
      options: JSON.stringify(r.options),
      data,
      createdAt: r.state.createdAt,
      undoneAt: r.state.undoneAt ?? null
    }
    db.insert(importRuns)
      .values({ id: k.id, ...row })
      .onConflictDoUpdate({ target: importRuns.id, set: row })
      .run()
  } else {
    const i = value as ItemRecord
    const row = { contentHash: i.hash, noteId: i.noteId ?? null, status: i.status, message: i.message ?? null, complete: i.complete, data }
    db.insert(importItems)
      .values({ runId: k.runId, sourceKey: k.path, ...row })
      .onConflictDoUpdate({ target: [importItems.runId, importItems.sourceKey], set: row })
      .run()
  }
}
const runRecords = (): RunRecord[] =>
  getDb()
    .select({ data: importRuns.data })
    .from(importRuns)
    .all()
    .map((r) => JSON.parse(r.data) as RunRecord)
export const items = (runId: string): ItemRecord[] =>
  getDb()
    .select({ data: importItems.data })
    .from(importItems)
    .where(eq(importItems.runId, runId))
    .all()
    .map((r) => JSON.parse(r.data) as ItemRecord)
export const itemKey = (runId: string, path: string): string => `item.${runId}.${path}`
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
  return runRecords()
    .sort((a, b) => b.state.createdAt - a.state.createdAt)
    .slice(0, 100)
    .map((r) => getRun(r.state.id))
}
export function importHistory(): ImportHistory[] {
  const runs = runRecords().sort((a, b) => a.state.createdAt - b.state.createdAt)
  return runs.flatMap((run) =>
    items(run.state.id)
      .sort((a, b) => a.path.localeCompare(b.path))
      .flatMap((i) => {
        if (!i.complete || i.status !== 'imported' || !i.noteId) return []
        const note = getNote(i.noteId)
        return note && !note.deletedAt ? [{ rootHash: i.rootHash, path: i.path, hash: i.hash, noteId: i.noteId }] : []
      })
  )
}
