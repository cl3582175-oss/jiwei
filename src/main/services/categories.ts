import { and, asc, eq, isNull, isNotNull, max } from 'drizzle-orm'
import { getDb } from '../db'
import { categories, notes, sources } from '../db/schema'
import { newId } from '../lib/ids'
import { deviceId } from './device'
import type { Category, CategoryKind } from '@shared/types'

type Row = typeof categories.$inferSelect

const toCategory = (r: Row): Category => ({
  id: r.id,
  parentId: r.parentId,
  name: r.name,
  kind: r.kind,
  color: r.color,
  sortOrder: r.sortOrder,
  createdAt: r.createdAt
})

export function listCategories(kind: CategoryKind): Category[] {
  return getDb()
    .select()
    .from(categories)
    .where(and(eq(categories.kind, kind), isNull(categories.deletedAt)))
    .orderBy(asc(categories.sortOrder), asc(categories.createdAt))
    .all()
    .map(toCategory)
}

/** 某分类及其所有后代分类的 ID（仅未删除） */
export function descendantIds(id: string): string[] {
  const all = getDb()
    .select({ id: categories.id, parentId: categories.parentId })
    .from(categories)
    .where(isNull(categories.deletedAt))
    .all()
  const out = [id]
  for (let i = 0; i < out.length; i++) for (const c of all) if (c.parentId === out[i]) out.push(c.id)
  return out
}

/** 已删除分类的 ID：其中的内容在列表中视为“未分类” */
export function deletedCategoryIds(): string[] {
  return getDb()
    .select({ id: categories.id })
    .from(categories)
    .where(isNotNull(categories.deletedAt))
    .all()
    .map((r) => r.id)
}

export function createCategory(kind: CategoryKind, name: string, parentId?: string | null): Category {
  const db = getDb()
  const top = db
    .select({ m: max(categories.sortOrder) })
    .from(categories)
    .where(eq(categories.kind, kind))
    .get()
  const now = Date.now()
  const row = {
    id: newId(),
    parentId: parentId ?? null,
    name: name.trim(),
    kind,
    color: null,
    sortOrder: (top?.m ?? 0) + 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    updatedBy: deviceId()
  }
  db.insert(categories).values(row).run()
  return toCategory(row)
}

export function updateCategory(id: string, patch: { name?: string; parentId?: string | null; color?: string | null }): void {
  if (patch.parentId && descendantIds(id).includes(patch.parentId)) throw new Error('Cannot move a category into its own descendant')
  getDb()
    .update(categories)
    .set({ ...patch, ...(patch.name ? { name: patch.name.trim() } : {}), updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(categories.id, id))
    .run()
}

/** 移入最近删除：连同子分类一起，使用相同删除时间以便整体还原 */
export function removeCategory(id: string): void {
  const ids = descendantIds(id)
  const now = Date.now()
  const db = getDb()
  db.transaction((tx) => {
    for (const cid of ids)
      tx.update(categories).set({ deletedAt: now, updatedAt: now, updatedBy: deviceId() }).where(eq(categories.id, cid)).run()
  })
}

export function restoreCategory(id: string): void {
  const db = getDb()
  const row = db.select().from(categories).where(eq(categories.id, id)).get()
  if (!row?.deletedAt) return
  const at = row.deletedAt
  // 还原同一批被删除的后代分类
  const all = db.select().from(categories).all()
  const ids = [id]
  for (let i = 0; i < ids.length; i++) for (const c of all) if (c.parentId === ids[i] && c.deletedAt === at) ids.push(c.id)
  db.transaction((tx) => {
    for (const cid of ids)
      tx.update(categories).set({ deletedAt: null, updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(categories.id, cid)).run()
    // 父分类仍在回收站时，挂到根级
    if (row.parentId && all.find((c) => c.id === row.parentId)?.deletedAt) {
      tx.update(categories).set({ parentId: null }).where(eq(categories.id, id)).run()
    }
  })
}

/** 永久删除：内容回到未分类，子分类一并删除 */
export function purgeCategory(id: string): void {
  const db = getDb()
  const all = db.select({ id: categories.id, parentId: categories.parentId }).from(categories).all()
  const ids = [id]
  for (let i = 0; i < ids.length; i++) for (const c of all) if (c.parentId === ids[i]) ids.push(c.id)
  db.transaction((tx) => {
    for (const cid of ids) {
      tx.update(notes).set({ categoryId: null }).where(eq(notes.categoryId, cid)).run()
      tx.update(sources).set({ categoryId: null }).where(eq(sources.categoryId, cid)).run()
      tx.delete(categories).where(eq(categories.id, cid)).run()
    }
  })
}
