import { getDb } from '../../db'
import { plugins } from '../../db/schema'
import { emit } from '../../events'
import type { PluginStarter, RoleStarters } from '@shared/plugins'
import { registeredPlugin } from './registry'
import { pluginOperationInProgress, pluginRow, readState, writeState } from './state'

function role(id: string) {
  const row = pluginRow(id)
  const parsed = registeredPlugin(id)
  if (!row.enabled || !parsed || parsed.extension?.category !== 'role') throw new Error('Role unavailable / 角色包不可用')
  return { row, parsed }
}

/** 时间并列时按安装身份排序：不受注册表加载顺序、停用/启用或更新影响。 */
export function listRoleStarters(): RoleStarters[] {
  return getDb()
    .select()
    .from(plugins)
    .all()
    .filter((row) => row.enabled && registeredPlugin(row.id)?.extension?.category === 'role')
    .sort((a, b) => b.installedAt - a.installedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((row) => {
      const { parsed } = role(row.id)
      const progress = readState(row.id).starterProgress
      if (progress?.dismissed) return []
      const completed = new Set(progress?.completed ?? [])
      const starters = parsed.starters.map((s) => ({ ...s, id: `${parsed.manifest.name}:${s.id}`, completed: completed.has(s.id) }))
      if (!starters.some((s) => !s.completed)) return []
      return [
        {
          pluginId: row.id,
          installedAt: row.installedAt,
          name: parsed.extension?.name ?? { zh: parsed.manifest.displayName ?? parsed.manifest.name, en: parsed.manifest.name },
          starters
        }
      ]
    })
}

/** 同步校验+写入，不与正在 await 的插件更新/卸载交错。只返回已验证导航数据，绝不执行动作。 */
export function completeRoleStarter(pluginId: string, starterId: string): PluginStarter['action'] {
  if (pluginOperationInProgress()) throw new Error('Plugin operation in progress; retry after it finishes')
  const { parsed } = role(pluginId)
  const starter = parsed.starters.find((s) => `${parsed.manifest.name}:${s.id}` === starterId)
  if (!starter) throw new Error('Starter unavailable / 起步建议不可用')
  const state = readState(pluginId)
  const completed = new Set(state.starterProgress?.completed ?? [])
  completed.add(starter.id)
  // 仅保留当前贡献的 ID，更新删掉的条目不会让进度无限增长。
  writeState(pluginId, {
    ...state,
    starterProgress: {
      dismissed: state.starterProgress?.dismissed ?? false,
      completed: parsed.starters.filter((s) => completed.has(s.id)).map((s) => s.id)
    }
  })
  emit('plugins:changed', {})
  return starter.action
}

export function dismissRoleStarters(pluginId: string): void {
  if (pluginOperationInProgress()) throw new Error('Plugin operation in progress; retry after it finishes')
  role(pluginId)
  const state = readState(pluginId)
  writeState(pluginId, { ...state, starterProgress: { dismissed: true, completed: state.starterProgress?.completed ?? [] } })
  emit('plugins:changed', {})
}
