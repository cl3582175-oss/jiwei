import { hostname, userInfo } from 'os'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { devices, meta, users } from '../db/schema'
import { newId } from '../lib/ids'
import type { Profile } from '@shared/types'

// 身份：一个知识库里可以有多个用户（协作），每个用户有多台设备。
// 各表的 updated_by 记录设备 ID，通过 devices 表对应到用户。

let cachedDevice: string | null = null
let cachedUser: string | null = null

function metaGet(key: string): string | null {
  return getDb().select().from(meta).where(eq(meta.key, key)).get()?.value ?? null
}

function metaSet(key: string, value: string): void {
  getDb().insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run()
}

/** 本机设备 ID：首次启动生成 */
export function deviceId(): string {
  if (cachedDevice) return cachedDevice
  cachedDevice = metaGet('device_id') ?? newId()
  metaSet('device_id', cachedDevice)
  return cachedDevice
}

/** 本机当前用户 ID */
export function userId(): string {
  if (cachedUser) return cachedUser
  cachedUser = metaGet('user_id') ?? newId()
  metaSet('user_id', cachedUser)
  return cachedUser
}

/** 启动时确保用户与设备记录存在，并更新最后在线时间 */
export function ensureIdentity(): void {
  const db = getDb()
  const now = Date.now()
  const uid = userId()
  const did = deviceId()
  if (!db.select().from(users).where(eq(users.id, uid)).get()) {
    const name = (() => {
      try {
        return userInfo().username || 'Me'
      } catch {
        return 'Me'
      }
    })()
    db.insert(users).values({ id: uid, name, createdAt: now, updatedAt: now, updatedBy: did }).run()
  }
  db.insert(devices)
    .values({ id: did, userId: uid, name: hostname(), platform: process.platform, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: devices.id, set: { lastSeenAt: now, name: hostname() } })
    .run()
}

export function getProfile(): Profile {
  const db = getDb()
  const u = db.select().from(users).where(eq(users.id, userId())).get()
  const d = db.select().from(devices).where(eq(devices.id, deviceId())).get()
  return { userId: userId(), name: u?.name ?? '', deviceId: deviceId(), deviceName: d?.name ?? hostname() }
}

export function setProfileName(name: string): Profile {
  getDb().update(users).set({ name: name.trim(), updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(users.id, userId())).run()
  return getProfile()
}

/** 知识库 ID：写在库内，文件夹移动后身份不变 */
export function vaultId(): string {
  const v = metaGet('vault_id') ?? newId()
  metaSet('vault_id', v)
  return v
}

export function vaultName(): string | null {
  return metaGet('vault_name')
}

export function setVaultName(name: string): void {
  metaSet('vault_name', name)
}
