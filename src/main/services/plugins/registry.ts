import { getDb } from '../../db'
import { plugins } from '../../db/schema'
import { taskRecipes } from '@shared/taskRecipes'
import type { PluginFramework, PluginTemplate, PluginRegistryItem } from '@shared/plugins'
import type { ParsedPlugin } from './components'

const loaded = new Map<string, ParsedPlugin>()
let revision = 0
export const pluginRegistryRevision = (): number => revision
export function replacePluginRegistry(id: string, parsed?: ParsedPlugin): void {
  if (parsed) loaded.set(id, parsed)
  else loaded.delete(id)
  revision++
}
export function registeredPlugin(id: string): ParsedPlugin | undefined {
  return loaded.get(id)
}
export function enabledPlugins(): { id: string; parsed: ParsedPlugin }[] {
  if (!loaded.size) return []
  return getDb()
    .select()
    .from(plugins)
    .all()
    .filter((r) => r.enabled && loaded.has(r.id))
    .map((r) => ({ id: r.id, parsed: loaded.get(r.id)! }))
}
// 目前内置作品/参谋没有独立模板表；B2 在同一注册表补入产品内置项，勿另建平行目录。
export function listTemplates(): PluginRegistryItem<PluginTemplate>[] {
  return enabledPlugins().flatMap(({ id, parsed }) =>
    parsed.templates.map((t) => ({ ...t, id: `${parsed.manifest.name}:${t.id}`, pluginId: id, source: 'plugin' as const }))
  )
}
export function listFrameworks(): PluginRegistryItem<PluginFramework>[] {
  return enabledPlugins().flatMap(({ id, parsed }) =>
    parsed.frameworks.map((t) => ({ ...t, id: `${parsed.manifest.name}:${t.id}`, pluginId: id, source: 'plugin' as const }))
  )
}
export function listRecipes() {
  return [
    ...taskRecipes.map((r) => ({ ...r, pluginId: undefined as string | undefined, source: 'builtin' as const })),
    ...enabledPlugins().flatMap(({ id, parsed }) =>
      parsed.recipes.map((r) => ({
        ...r,
        id: `${parsed.manifest.name}:${r.id}`,
        task: { ...r.task, recipe: `${parsed.manifest.name}:${r.id}` },
        pluginId: id,
        source: 'plugin' as const
      }))
    )
  ]
}
