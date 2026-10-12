import { randomBytes } from 'crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db'
import { meta } from '../../db/schema'
import {
  RoleBatchSelections,
  type RoleBatchPreview,
  type RoleBatchRecovery,
  type RoleCatalogCard,
  type PluginPreview
} from '@shared/plugins'
import { AcquisitionBatch } from './acquisition'
import { registeredPlugin } from './registry'
import { pluginContributionCounts } from './components'
import { catalogPlugins, OFFICIAL_MARKET } from './markets'
import { inspectPlugin, confirmPluginInstall, cancelPluginPreview, listPlugins } from './install'

/** 已安装且内容可用的插件 ID。内容丢失或校验失败的安装（available=false）不算已装，让角色选择可以重新预览修复。 */
const usable = (): Set<string> =>
  new Set(
    listPlugins()
      .filter((p) => p.available)
      .map((p) => p.id)
  )
const presets = ['school', 'research', 'kaoyan', 'jobseeker', 'product', 'teacher', 'creator', 'manager']
const lifetime = 10 * 60_000
const recoveryKey = 'plugin.role-selection:last'
interface Selection {
  owner: number
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  expiresAt: number
  busy: boolean
  selected: string[]
  previews: PluginPreview[]
}
const selections = new Map<string, Selection>()
let confirming = false

export function roleCatalog(): RoleCatalogCard[] {
  const installed = new Map(listPlugins().map((p) => [p.id, p]))
  const rank = (id: string): number => presets.findIndex((x) => id === `role-${x}@${OFFICIAL_MARKET.name}`)
  const cards = catalogPlugins().filter((p) => p.category === 'role')
  // 本地安装或已移除市场的角色仍显示真实启用状态，不能只列当前市场清单。
  for (const plugin of installed.values()) {
    if (cards.some((c) => c.id === plugin.id)) continue
    const parsed = registeredPlugin(plugin.id)
    if (parsed?.extension?.category !== 'role') continue
    cards.push({
      id: plugin.id,
      name: parsed.manifest.name,
      displayName: parsed.manifest.displayName ?? parsed.manifest.name,
      description: parsed.manifest.description ?? '',
      keywords: parsed.manifest.keywords ?? [],
      category: 'role',
      localizedName: parsed.extension.name,
      localizedDescription: parsed.extension.description,
      counts: pluginContributionCounts(parsed),
      origin: plugin.origin,
      supported: true,
      installedVersion: plugin.version,
      version: plugin.version,
      updateUnavailable: plugin.origin.kind === 'market',
      updateAvailable: false
    })
  }
  return cards
    .map((card) => {
      const index = rank(card.id)
      const parsed = installed.has(card.id) ? registeredPlugin(card.id) : undefined
      return {
        ...card,
        ...(parsed
          ? {
              counts: pluginContributionCounts(parsed),
              localizedName: parsed.extension?.name,
              localizedDescription: parsed.extension?.description
            }
          : {}),
        group: index < 0 ? ('other' as const) : index < 4 ? ('student' as const) : ('work' as const),
        enabled: installed.get(card.id)?.enabled ?? null
      }
    })
    .sort((a, b) => {
      const ar = rank(a.id),
        br = rank(b.id)
      return (ar < 0 ? 8 : ar) - (br < 0 ? 8 : br) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    })
}

export function beginRoleSelection(owner: number): string {
  if (owner < 0 || selections.size >= 32 || [...selections.values()].filter((s) => s.owner === owner).length >= 2)
    throw new Error('Too many pending role selections / 待确认角色过多')
  const token = randomBytes(32).toString('hex')
  const timer = setTimeout(() => void cancelRoleSelection(owner, token).catch(() => undefined), lifetime)
  timer.unref()
  selections.set(token, {
    owner,
    controller: new AbortController(),
    timer,
    expiresAt: Date.now() + lifetime,
    busy: false,
    selected: [],
    previews: []
  })
  return token
}
function selection(owner: number, token: string): Selection {
  const item = selections.get(token)
  if (!item || item.owner !== owner) throw new Error('Invalid role selection / 角色选择已失效')
  if (Date.now() >= item.expiresAt || item.controller.signal.aborted) throw new Error('Role selection expired or canceled / 请重新预览角色')
  return item
}
async function cleanup(token: string, item: Selection): Promise<void> {
  clearTimeout(item.timer)
  await Promise.allSettled(item.previews.map((p) => cancelPluginPreview(p.token)))
  selections.delete(token)
}
export async function cancelRoleSelection(owner: number, token: string): Promise<void> {
  const item = selections.get(token)
  if (!item || item.owner !== owner) return
  item.controller.abort()
  clearTimeout(item.timer)
  await Promise.allSettled(item.previews.map((p) => cancelPluginPreview(p.token)))
  if (!item.busy) selections.delete(token)
}
export async function cancelOwnerRoleSelections(owner: number): Promise<void> {
  for (const [token, item] of selections) if (item.owner === owner) await cancelRoleSelection(owner, token)
}

export async function previewRoles(owner: number, token: string, input: string[]): Promise<RoleBatchPreview> {
  const ids = z
    .array(z.string().min(1).max(257))
    .min(1)
    .max(8)
    .refine((v) => new Set(v).size === v.length)
    .parse(input)
  const item = selection(owner, token)
  if (item.busy || item.selected.length) throw new Error('Role selection already prepared / 请重新开始选择')
  const catalog = roleCatalog()
  if (ids.some((id) => !catalog.some((c) => c.id === id && c.supported))) throw new Error('Role unavailable / 角色包不可用')
  item.busy = true
  item.selected = ids
  const batch = new AcquisitionBatch(item.controller.signal, token)
  let result: RoleBatchPreview
  try {
    const ok = usable()
    const alreadyInstalled = ids.filter((id) => ok.has(id))
    for (const id of ids.filter((id) => !alreadyInstalled.includes(id))) {
      selection(owner, token)
      const card = catalog.find((c) => c.id === id)!
      const preview = await inspectPlugin(
        { kind: 'market', market: card.origin.market, name: card.name },
        { signal: item.controller.signal, id: token, batch }
      )
      item.previews.push(preview)
      selection(owner, token)
      if (preview.category !== 'role' || preview.id !== id) throw new Error('Role changed after catalog; refresh / 角色目录已变化')
      item.expiresAt = Math.min(item.expiresAt, preview.expiresAt)
    }
    result = { token, expiresAt: item.expiresAt, alreadyInstalled, roles: item.previews.map(({ token: _token, ...preview }) => preview) }
  } catch (error) {
    await cleanup(token, item)
    throw error
  } finally {
    await batch.cleanup()
    item.busy = false
  }
  // 收尾期间被取消：取消时因 busy 没能删除，这里补删，并且不返回可用的预览
  if (item.controller.signal.aborted) {
    await cleanup(token, item)
    throw new Error('Role selection expired or canceled / 请重新预览角色')
  }
  return result
}

function saveRecovery(value: RoleBatchRecovery): void {
  getDb()
    .insert(meta)
    .values({ key: recoveryKey, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } })
    .run()
}
function snapshot(selected: string[], status: RoleBatchRecovery['status'], error?: string): RoleBatchRecovery {
  const ids = usable()
  const installed = selected.filter((id) => ids.has(id)),
    remaining = selected.filter((id) => !ids.has(id))
  return {
    selected,
    installed,
    remaining,
    status: status === 'complete' && remaining.length ? 'partial' : status,
    ...(error ? { error } : {})
  }
}
export function roleRecovery(): RoleBatchRecovery | null {
  const saved = getDb().select().from(meta).where(eq(meta.key, recoveryKey)).get()
  if (!saved) return null
  const value = JSON.parse(saved.value) as RoleBatchRecovery
  return snapshot(value.selected, value.status, value.error)
}

/** 每个插件沿用原安装事务；已提交包保留。未提交包丢弃预览，重试必须重新确认。
 * journal 只存身份与结果，不存配置/凭据；崩溃后以真实安装行重建已完成/待重试清单。 */
export async function confirmRoles(owner: number, token: string, input: z.input<typeof RoleBatchSelections>): Promise<RoleBatchRecovery> {
  const item = selection(owner, token)
  if (item.busy || confirming) throw new Error('Role confirmation already running')
  const choices = RoleBatchSelections.parse(input)
  if (!item.selected.length || choices.length !== item.previews.length || choices.some((c) => !item.previews.some((p) => p.id === c.id)))
    throw new Error('Selection does not match combined preview / 确认内容与预览不一致')
  item.busy = true
  confirming = true
  try {
    saveRecovery(snapshot(item.selected, 'interrupted'))
    for (const preview of item.previews) {
      selection(owner, token)
      await confirmPluginInstall(preview.token, choices.find((c) => c.id === preview.id)!.options)
      saveRecovery(snapshot(item.selected, 'interrupted'))
    }
    const result = snapshot(item.selected, 'complete')
    saveRecovery(result)
    return result
  } catch (error) {
    const result = snapshot(
      item.selected,
      item.controller.signal.aborted ? 'canceled' : 'partial',
      error instanceof Error ? error.message : 'Role installation failed / 角色安装失败'
    )
    saveRecovery(result)
    return result
  } finally {
    await cleanup(token, item)
    item.busy = false
    confirming = false
  }
}
