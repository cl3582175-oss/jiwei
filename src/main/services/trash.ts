import { and, eq, isNotNull, lt } from 'drizzle-orm'
import { getDb } from '../db'
import { notes, noteLinks, noteSources, sources } from '../db/schema'
import { purgeSource } from './sources'
import { TRASH_RETENTION_DAYS, type TrashItem } from '@shared/types'

const DAY = 86_400_000

function daysLeft(deletedAt: number): number {
  return Math.max(0, Math.ceil((deletedAt + TRASH_RETENTION_DAYS * DAY - Date.now()) / DAY))
}

export function listTrash(): TrashItem[] {
  const db = getDb()
  const n = db
    .select({ id: notes.id, title: notes.title, deletedAt: notes.deletedAt })
    .from(notes)
    .where(isNotNull(notes.deletedAt))
    .all()
  const s = db
    .select({ id: sources.id, title: sources.title, deletedAt: sources.deletedAt })
    .from(sources)
    .where(isNotNull(sources.deletedAt))
    .all()
  return [
    ...n.map((r) => ({ type: 'note' as const, id: r.id, title: r.title, deletedAt: r.deletedAt!, daysLeft: daysLeft(r.deletedAt!) })),
    ...s.map((r) => ({ type: 'source' as const, id: r.id, title: r.title, deletedAt: r.deletedAt!, daysLeft: daysLeft(r.deletedAt!) }))
  ].sort((a, b) => b.deletedAt - a.deletedAt)
}

export function restore(type: TrashItem['type'], id: string): void {
  const table = type === 'note' ? notes : sources
  getDb().update(table).set({ deletedAt: null }).where(eq(table.id, id)).run()
}

export async function purge(type: TrashItem['type'], id: string): Promise<void> {
  const db = getDb()
  if (type === 'note') {
    db.transaction((tx) => {
      tx.delete(noteLinks).where(eq(noteLinks.fromId, id)).run()
      tx.delete(noteLinks).where(eq(noteLinks.toId, id)).run()
      tx.delete(noteSources).where(eq(noteSources.noteId, id)).run()
      tx.delete(notes).where(eq(notes.id, id)).run()
    })
  } else {
    db.delete(noteSources).where(eq(noteSources.sourceId, id)).run()
    await purgeSource(id)
  }
}

export async function emptyTrash(): Promise<void> {
  for (const item of listTrash()) await purge(item.type, item.id)
}

/** 自动清理超过保留期的项目；启动时与每小时执行 */
export async function purgeExpired(): Promise<number> {
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * DAY
  const db = getDb()
  const n = db.select({ id: notes.id }).from(notes).where(and(isNotNull(notes.deletedAt), lt(notes.deletedAt, cutoff))).all()
  const s = db
    .select({ id: sources.id })
    .from(sources)
    .where(and(isNotNull(sources.deletedAt), lt(sources.deletedAt, cutoff)))
    .all()
  for (const r of n) await purge('note', r.id)
  for (const r of s) await purge('source', r.id)
  return n.length + s.length
}
