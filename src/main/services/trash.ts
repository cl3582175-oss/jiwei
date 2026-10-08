import { and, eq, isNotNull, or } from 'drizzle-orm'
import { getDb } from '../db'
import { annotations, categories, links, notes, sources } from '../db/schema'
import { deleteNoteRow } from './notes'
import { purgeDocData } from './docs'
import { deleteProposalsForNote } from './proposals'
import { purgeSource } from './sources'
import { purgeCategory, restoreCategory } from './categories'
import { collectGarbage } from './assets'
import { TRASH_RETENTION_DAYS, type TrashItem, type TrashType } from '@shared/types'

const DAY = 86_400_000

function daysLeft(deletedAt: number): number {
  return Math.max(0, Math.ceil((deletedAt + TRASH_RETENTION_DAYS * DAY - Date.now()) / DAY))
}

export function listTrash(): TrashItem[] {
  const db = getDb()
  const item = (type: TrashType) => (r: { id: string; title: string; deletedAt: number | null }): TrashItem => ({
    type,
    id: r.id,
    title: r.title,
    deletedAt: r.deletedAt!,
    daysLeft: daysLeft(r.deletedAt!)
  })
  const n = db.select({ id: notes.id, title: notes.title, deletedAt: notes.deletedAt }).from(notes).where(isNotNull(notes.deletedAt)).all()
  const s = db.select({ id: sources.id, title: sources.title, deletedAt: sources.deletedAt }).from(sources).where(isNotNull(sources.deletedAt)).all()
  // 子分类随父分类一起删除时只显示父分类
  const c = db.select().from(categories).where(isNotNull(categories.deletedAt)).all()
  const cTop = c.filter((x) => !c.some((p) => p.id === x.parentId && p.deletedAt === x.deletedAt))
  return [
    ...n.map(item('note')),
    ...s.map(item('source')),
    ...cTop.map((r) => item('category')({ id: r.id, title: r.name, deletedAt: r.deletedAt }))
  ].sort((a, b) => b.deletedAt - a.deletedAt)
}

export function restore(type: TrashType, id: string): void {
  if (type === 'category') return restoreCategory(id)
  const table = type === 'note' ? notes : sources
  getDb().update(table).set({ deletedAt: null, updatedAt: Date.now() }).where(eq(table.id, id)).run()
}

export async function purge(type: TrashType, id: string): Promise<void> {
  const db = getDb()
  if (type === 'category') return purgeCategory(id)
  // 清理指向 / 来自该对象的关联与批注
  db.delete(links)
    .where(or(and(eq(links.fromType, type), eq(links.fromId, id)), and(eq(links.toType, type), eq(links.toId, id))))
    .run()
  db.delete(annotations).where(and(eq(annotations.targetType, type), eq(annotations.targetId, id))).run()
  if (type === 'note') {
    db.transaction(() => {
      purgeDocData(id)
      deleteProposalsForNote(id)
      deleteNoteRow(id)
    })
    await collectGarbage()
  } else {
    await purgeSource(id)
  }
}

export async function emptyTrash(): Promise<void> {
  for (const item of listTrash()) await purge(item.type, item.id)
}

/** 自动清理超过保留期的项目；启动时与每小时执行 */
export async function purgeExpired(): Promise<number> {
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * DAY
  const expired = listTrash().filter((i) => i.deletedAt < cutoff)
  for (const i of expired) await purge(i.type, i.id)
  return expired.length
}

