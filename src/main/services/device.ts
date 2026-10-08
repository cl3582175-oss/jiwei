import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { meta } from '../db/schema'
import { newId } from '../lib/ids'

let cached: string | null = null

/** 本机设备 ID：首次启动生成，用于同步时标记修改来源 */
export function deviceId(): string {
  if (cached) return cached
  const db = getDb()
  const row = db.select().from(meta).where(eq(meta.key, 'device_id')).get()
  if (row) return (cached = row.value)
  cached = newId()
  db.insert(meta).values({ key: 'device_id', value: cached }).run()
  return cached
}
