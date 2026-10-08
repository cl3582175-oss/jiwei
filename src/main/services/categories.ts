import { randomUUID } from 'crypto'
import { and, asc, eq, max } from 'drizzle-orm'
import { getDb } from '../db'
import { categories, notes, sources } from '../db/schema'
import type { Category, CategoryKind } from '@shared/types'

export function listCategories(kind: CategoryKind): Category[] {
  return getDb()
    .select()
    .from(categories)
    .where(eq(categories.kind, kind))
    .orderBy(asc(categories.sortOrder), asc(categories.createdAt))
    .all() as Category[]
}

export function createCategory(kind: CategoryKind, name: string): Category {
  const db = getDb()
  const top = db.select({ m: max(categories.sortOrder) }).from(categories).where(eq(categories.kind, kind)).get()
  const row = { id: randomUUID(), name: name.trim(), kind, sortOrder: (top?.m ?? 0) + 1, createdAt: Date.now() }
  db.insert(categories).values(row).run()
  return row
}

export function renameCategory(id: string, name: string): void {
  getDb().update(categories).set({ name: name.trim() }).where(eq(categories.id, id)).run()
}

/** 删除分类不会删除其中内容，内容回到“未分类” */
export function removeCategory(id: string): void {
  getDb().transaction((tx) => {
    tx.update(notes).set({ categoryId: null }).where(and(eq(notes.categoryId, id))).run()
    tx.update(sources).set({ categoryId: null }).where(eq(sources.categoryId, id)).run()
    tx.delete(categories).where(eq(categories.id, id)).run()
  })
}
