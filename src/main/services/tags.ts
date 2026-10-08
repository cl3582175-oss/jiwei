import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { getDb } from '../db'
import { taggings, tags } from '../db/schema'
import { newId } from '../lib/ids'
import { deviceId } from './device'
import type { Tag } from '@shared/types'

export function listTags(): Tag[] {
  return getDb()
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(isNull(tags.deletedAt))
    .orderBy(asc(tags.name))
    .all()
}

export function ensureTag(name: string): Tag {
  const n = name.trim().replace(/^#/, '')
  if (!n) throw new Error('Empty tag name')
  const db = getDb()
  const existing = db.select().from(tags).where(eq(tags.name, n)).get()
  if (existing) {
    if (existing.deletedAt) db.update(tags).set({ deletedAt: null, updatedAt: Date.now() }).where(eq(tags.id, existing.id)).run()
    return { id: existing.id, name: existing.name, color: existing.color }
  }
  const now = Date.now()
  const row = { id: newId(), name: n, color: null, createdAt: now, updatedAt: now, updatedBy: deviceId() }
  db.insert(tags).values(row).run()
  return { id: row.id, name: row.name, color: null }
}

export function renameTag(id: string, name: string): void {
  getDb().update(tags).set({ name: name.trim(), updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(tags.id, id)).run()
}

export function removeTag(id: string): void {
  const db = getDb()
  db.transaction((tx) => {
    tx.delete(taggings).where(eq(taggings.tagId, id)).run()
    tx.update(tags).set({ deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(tags.id, id)).run()
  })
}

export function setTags(entityType: 'note' | 'source', entityId: string, tagIds: string[]): void {
  const db = getDb()
  db.transaction((tx) => {
    tx.delete(taggings)
      .where(and(eq(taggings.entityType, entityType), eq(taggings.entityId, entityId)))
      .run()
    for (const tagId of new Set(tagIds)) tx.insert(taggings).values({ tagId, entityType, entityId, createdAt: Date.now() }).run()
  })
}

/** 批量读取实体的标签 ID */
export function tagIdsFor(entityType: 'note' | 'source', ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (ids.length === 0) return map
  const db = getDb()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = db
      .select({ entityId: taggings.entityId, tagId: taggings.tagId })
      .from(taggings)
      .where(and(eq(taggings.entityType, entityType), inArray(taggings.entityId, ids.slice(i, i + 500))))
      .all()
    for (const r of rows) map.set(r.entityId, [...(map.get(r.entityId) ?? []), r.tagId])
  }
  return map
}

export function entitiesWithTag(entityType: 'note' | 'source', tagId: string): string[] {
  return getDb()
    .select({ id: taggings.entityId })
    .from(taggings)
    .where(and(eq(taggings.entityType, entityType), eq(taggings.tagId, tagId)))
    .all()
    .map((r) => r.id)
}
