import { app } from 'electron'
import { createHash } from 'crypto'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { meta, plugins } from '../../db/schema'
import type { ParsePluginOptions } from './components'
import type { PluginCapabilities, PluginOrigin } from '@shared/plugins'

export interface InstalledVersion {
  hash: string
  directory: string
  version: string
  options: ParsePluginOptions
  capabilities: PluginCapabilities
}
export interface PluginState {
  origin: PluginOrigin
  current: InstalledVersion
  previous?: InstalledVersion
  /** 只保存敏感字段是否已设置，读取列表不解密。 */
  secretKeys: string[]
}
export const pluginRoot = (): string => join(app.getPath('userData'), 'plugins')
export const pathKey = (id: string): string => createHash('sha256').update(id).digest('hex')
export const pluginCache = (id: string): string => join(pluginRoot(), 'cache', pathKey(id))
export const pluginData = (id: string): string => join(pluginRoot(), 'data', pathKey(id))
export const stateKey = (id: string): string => `plugin.state:${id}`
export function pluginRow(id: string) {
  const row = getDb().select().from(plugins).where(eq(plugins.id, id)).get()
  if (!row) throw new Error('Plugin not found')
  return row
}
export function readState(id: string): PluginState {
  const item = getDb()
    .select()
    .from(meta)
    .where(eq(meta.key, stateKey(id)))
    .get()
  if (!item) throw new Error('Plugin state unavailable')
  return JSON.parse(item.value) as PluginState
}
export function writeState(id: string, state: PluginState): void {
  getDb()
    .insert(meta)
    .values({ key: stateKey(id), value: JSON.stringify(state) })
    .onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(state) } })
    .run()
}
// IPC 生命周期和 MCP 配置修改共用互斥，避免 await 期间交错修改同一插件。
let busy = false
export const pluginOperationInProgress = (): boolean => busy
export async function pluginMutation<T>(run: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('Plugin operation in progress; retry after it finishes')
  busy = true
  try {
    return await run()
  } finally {
    busy = false
  }
}
