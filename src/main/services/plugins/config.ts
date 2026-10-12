import { eq } from 'drizzle-orm'
import type { PluginConfig, PluginManifest, PluginMcp } from '@shared/plugins'
import { PluginConfigValues } from '@shared/plugins'
import { getDb } from '../../db'
import { mcpServers } from '../../db/schema'
import { sealJson, openJson } from '../mcp/secrets'
import { registeredPlugin } from './registry'
import { pluginRow, readState, pluginData } from './state'
import { resolvePluginMcp } from './components'

const missing = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
export function validateConfig(manifest: PluginManifest, values: PluginConfig): PluginConfig {
  const result: PluginConfig = {}
  for (const [key, value] of Object.entries(PluginConfigValues.parse(values))) {
    const field = manifest.userConfig?.[key]
    if (!field) throw new Error('Unknown plugin configuration field')
    if (value === null) continue
    const items = field.multiple ? (Array.isArray(value) ? value : null) : [value]
    if (!items || (!field.multiple && Array.isArray(value))) throw new Error('Invalid plugin configuration type')
    for (const item of items) {
      if (typeof item !== (field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string'))
        throw new Error('Invalid plugin configuration type')
      if (field.options && !field.options.includes(item as never)) throw new Error('Invalid plugin configuration option')
      if (typeof item === 'number' && ((field.min !== undefined && item < field.min) || (field.max !== undefined && item > field.max)))
        throw new Error('Plugin configuration outside allowed range')
    }
    result[key] = value
  }
  return result
}
/** 原有密文原样保留；只在敏感字段确实修改时为合并而读取此插件的密文。 */
export function prepareConfig(manifest: PluginManifest, patch: PluginConfig, old?: ReturnType<typeof pluginRow>) {
  const publicValues: PluginConfig = old ? JSON.parse(old.config) : {}
  const state = old ? readState(old.id) : undefined
  let secretKeys = [...(state?.secretKeys ?? [])]
  let secretsEnc = old?.secretsEnc ?? null
  const fields = manifest.userConfig ?? {}
  const sensitivePatch = Object.keys(patch).some((k) => fields[k]?.sensitive)
  // schema 类型发生变化时不把旧 secret 降级成公开值。
  const secrets = sensitivePatch ? openJson<PluginConfig>(secretsEnc, {}) : {}
  validateConfig(manifest, patch)
  for (const [key, value] of Object.entries(patch)) {
    if (fields[key].sensitive) {
      delete publicValues[key]
      if (value === null || missing(value)) {
        delete secrets[key]
        secretKeys = secretKeys.filter((k) => k !== key)
      } else {
        secrets[key] = value
        if (!secretKeys.includes(key)) secretKeys.push(key)
      }
    } else if (value === null) delete publicValues[key]
    else publicValues[key] = value
  }
  for (const [key, field] of Object.entries(fields)) {
    if (field.sensitive) delete publicValues[key]
    else if (publicValues[key] === undefined && field.default !== undefined) publicValues[key] = field.default
  }
  for (const key of Object.keys(publicValues)) if (!fields[key] || fields[key].sensitive) delete publicValues[key]
  validateConfig(manifest, publicValues)
  if (sensitivePatch) secretsEnc = Object.keys(secrets).length ? sealJson(secrets) : null
  secretKeys = secretKeys.filter((k) => fields[k]?.sensitive)
  return { config: JSON.stringify(publicValues), secretsEnc, secretKeys }
}
export function pluginMcpDeclaration(server: typeof mcpServers.$inferSelect): PluginMcp {
  if (!server.pluginId) throw new Error('Not a plugin server')
  const installed = pluginRow(server.pluginId),
    parsed = registeredPlugin(server.pluginId)
  if (!installed.enabled || !parsed) throw new Error('Plugin is disabled or unavailable')
  const declaration = parsed.mcpServers[server.name]
  if (!declaration || declaration.type === 'sse') throw new Error('Plugin MCP declaration unavailable')
  return declaration
}
export function assertPluginMcpReady(server: typeof mcpServers.$inferSelect): void {
  const declaration = pluginMcpDeclaration(server),
    id = server.pluginId!,
    installed = pluginRow(id)
  const parsed = registeredPlugin(id)!,
    state = readState(id),
    values = JSON.parse(installed.config) as PluginConfig
  const referenced = new Set([...JSON.stringify(declaration).matchAll(/\$\{user_config\.([^}]+)\}/g)].map((m) => m[1]))
  for (const [key, field] of Object.entries(parsed.manifest.userConfig ?? {})) {
    if (referenced.has(key) && (field.sensitive ? !state.secretKeys.includes(key) : missing(values[key])))
      throw new Error('Required plugin configuration is not set')
  }
  if (
    server.command !== (declaration.command ?? null) ||
    server.args !== JSON.stringify(declaration.args) ||
    server.cwd !== (declaration.cwd ?? null) ||
    server.url !== (declaration.url ?? null)
  )
    throw new Error('Plugin MCP declaration differs from confirmed capabilities')
}
/** 只由 MCP makeTransport 调用；返回值从不写文件/数据库/日志/IPC。 */
export function resolveInstalledMcp(server: typeof mcpServers.$inferSelect): PluginMcp {
  assertPluginMcpReady(server)
  const id = server.pluginId!,
    row = pluginRow(id),
    state = readState(id)
  const manifest = registeredPlugin(id)!.manifest
  const secrets = Object.fromEntries(
    Object.entries(openJson<PluginConfig>(row.secretsEnc, {})).filter(
      ([key]) => manifest.userConfig?.[key]?.sensitive && state.secretKeys.includes(key)
    )
  )
  const values = validateConfig(manifest, { ...JSON.parse(row.config), ...secrets })
  const resolved = resolvePluginMcp(pluginMcpDeclaration(server), {
    root: state.current.directory,
    data: pluginData(id),
    userConfig: values
  })
  if (resolved.url) assertPluginDomain(id, resolved.url)
  return resolved
}
export function assertPluginDomain(id: string, value: string): void {
  if (!pluginRow(id).enabled) throw new Error('Plugin is disabled')
  const url = new URL(value),
    caps = readState(id).current.capabilities
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !caps.domains.includes(url.hostname))
    throw new Error('Plugin MCP domain was not confirmed')
}
export function disablePluginMcpRows(id: string): void {
  getDb().update(mcpServers).set({ enabled: false }).where(eq(mcpServers.pluginId, id)).run()
}
