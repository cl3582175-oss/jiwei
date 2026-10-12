import { z } from 'zod'
import { TaskSave, TASK_READ_TOOLS } from './tasks'
import { FeedKind } from './discover'

/** 插件协议版本独立于应用发布版本；发布仍由审查者收尾。 */
export const PLUGIN_API_VERSION = '0.10.0'
const dangerous = new Set(['__proto__', 'prototype', 'constructor'])
const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
export const PluginNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (s) =>
      !hasControl(s) && !/[\s@:/\\\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(s) && s !== '.' && !s.includes('..') && !dangerous.has(s),
    'Invalid plugin name'
  )
export const MarketNameSchema = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((s) => !s.includes('..') && !dangerous.has(s))
export const LocalizedSchema = z.object({ zh: z.string().min(1).max(4000), en: z.string().min(1).max(4000) })
export function safeRelativePath(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    hasControl(value) ||
    value.includes(':') ||
    value.split('/').includes('..')
  )
    throw new Error('Unsafe plugin path')
  const parts = value.split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => dangerous.has(p))) throw new Error('Unsafe plugin path')
  return parts.join('/') || '.'
}
const PathSchema = z
  .string()
  .max(4000)
  .refine((v) => {
    try {
      safeRelativePath(v)
      return true
    } catch {
      return false
    }
  }, 'Unsafe plugin path')
const Paths = z.union([PathSchema, z.array(PathSchema).max(2000)])
const key = PluginNameSchema
export const UserConfigOptionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
    title: z.string().min(1).max(500),
    description: z.string().max(4000),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    multiple: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())]).optional(),
    options: z.array(z.union([z.string(), z.number()])).optional(),
    min: z.number().optional(),
    max: z.number().optional()
  })
  .strict()
const strings = z.record(
  z
    .string()
    .min(1)
    .refine((v) => !dangerous.has(v)),
  z.string()
)
export const PluginMcpSchema = z
  .object({
    type: z.enum(['stdio', 'http', 'sse']).optional(),
    command: z.string().min(1).max(4000).optional(),
    args: z.array(z.string()).max(200).default([]),
    cwd: z.string().max(4000).optional(),
    env: strings.default({}),
    url: z
      .string()
      .max(4000)
      .refine((value) => {
        try {
          const url = new URL(value.replace(/\$\{[^}]+\}/g, 'placeholder'))
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        } catch {
          return false
        }
      }, 'MCP URL must use HTTP(S) without credentials')
      .optional(),
    headers: strings.default({})
  })
  .refine((s) => (s.command ? !s.url && (!s.type || s.type === 'stdio') : !!s.url && s.type !== 'stdio'), 'MCP needs one transport')
export const PluginMcpMapSchema = z.record(key, PluginMcpSchema)
const McpPart = z.union([PathSchema, PluginMcpMapSchema])
const Command = z
  .object({
    source: PathSchema.optional(),
    content: z
      .string()
      .max(1024 * 1024)
      .optional(),
    description: z.string().max(1024).optional()
  })
  .refine((v) => !!v.source !== (v.content !== undefined), 'Command needs source or content')
const components = {
  skills: Paths.optional(),
  commands: z.union([Paths, z.record(key, Command)]).optional(),
  mcpServers: z.union([McpPart, z.array(McpPart).max(200)]).optional(),
  agents: z.unknown().optional(),
  hooks: z.unknown().optional(),
  lspServers: z.unknown().optional(),
  outputStyles: z.unknown().optional(),
  themes: z.unknown().optional(),
  monitors: z.unknown().optional(),
  workflows: z.unknown().optional(),
  bin: z.unknown().optional()
}
export const PluginManifestSchema = z.object({
  name: PluginNameSchema,
  displayName: z.string().max(500).optional(),
  version: z.string().min(1).max(200).optional(),
  description: z.string().max(8000).optional(),
  author: z.object({ name: z.string(), email: z.string().optional(), url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  ...components,
  userConfig: z.record(key, UserConfigOptionSchema).optional()
})
export const PluginSourceSchema = z.union([
  PathSchema,
  z
    .object({
      source: z.string().min(1),
      repo: z.string().optional(),
      url: z.string().optional(),
      path: PathSchema.optional(),
      ref: z.string().optional(),
      sha: z.string().optional()
    })
    .passthrough()
])
export const MarketplaceEntrySchema = PluginManifestSchema.extend({ source: PluginSourceSchema, strict: z.boolean().default(true) })
export const MarketplaceSchema = z
  .object({
    name: MarketNameSchema,
    owner: z.object({ name: z.string().min(1), email: z.string().optional() }),
    metadata: z
      .object({ description: z.string().optional(), version: z.string().optional(), pluginRoot: PathSchema.optional() })
      .optional(),
    plugins: z.array(MarketplaceEntrySchema).max(2000)
  })
  .refine((m) => new Set(m.plugins.map((p) => p.name)).size === m.plugins.length, 'Duplicate plugins')
export function parseMarketplace(raw: unknown, trustedBuiltin = false): z.infer<typeof MarketplaceSchema> {
  const market = MarketplaceSchema.parse(raw)
  if (/^jiwei(?:$|-)/i.test(market.name) && !(trustedBuiltin && market.name === 'jiwei')) throw new Error('Reserved marketplace name')
  return market
}
export function pluginSourceSupport(source: z.infer<typeof PluginSourceSchema>): { supported: boolean; reason?: string } {
  if (typeof source === 'string') return { supported: true }
  const github = (s?: string) => !!s && (/^[\w.-]+\/[\w.-]+$/.test(s) || /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(s))
  const supported =
    source.source === 'github'
      ? github(source.repo)
      : source.source === 'git-subdir'
        ? github(source.url) && !!source.path
        : source.source === 'url'
          ? github(source.url)
          : source.source === 'archive'
            ? /^https:\/\//.test(source.url ?? '')
            : false
  return { supported, ...(supported ? {} : { reason: 'unsupported_source' }) }
}
export const JiweiExtSchema = z.object({
  schema: z.literal(1),
  name: LocalizedSchema.optional(),
  description: LocalizedSchema.optional(),
  category: z.enum(['role', 'skills', 'templates', 'sources', 'connector', 'renderer']).optional(),
  roles: z.array(z.string()).max(50).optional(),
  engines: z.object({ jiwei: z.string().min(1) }).optional(),
  cost: LocalizedSchema.optional(),
  dataLeavesDevice: z.boolean().default(false),
  renderers: z.array(z.string()).max(10).default([])
})
export const PluginTemplateSchema = z.object({
  id: PluginNameSchema,
  type: z.enum(['article', 'slides', 'video']),
  title: LocalizedSchema,
  description: LocalizedSchema,
  audience: z.string().max(500).optional(),
  mode: z.string().max(100).optional(),
  outline: z.array(z.string().max(2000)).max(12),
  guidance: z.string().max(2000).optional()
})
export const PluginFrameworkSchema = z.object({
  id: PluginNameSchema,
  title: LocalizedSchema,
  description: LocalizedSchema,
  criteria: z
    .array(z.object({ name: z.string().min(1).max(200), weight: z.number().int().min(1).max(5), hint: z.string().max(2000) }))
    .min(2)
    .max(8),
  questions: z.array(z.string().max(2000)).max(8)
})
export const PLUGIN_RECIPE_TOOLS: readonly string[] = [...TASK_READ_TOOLS, 'mail_list', 'mail_read']
export const PluginRecipeSchema = z.object({
  id: PluginNameSchema,
  name: LocalizedSchema,
  instructionEn: z.string().min(1).max(12000),
  task: TaskSave.omit({ id: true }).refine((v) => v.tools.every((t) => PLUGIN_RECIPE_TOOLS.includes(t)), 'Unknown task tool'),
  requires: z.enum(['mail', 'discover']).optional()
})
// 起步卡只声明导航与预填数据；不接受执行、自动发送或任意 URL。
const StarterReference = z
  .string()
  .min(1)
  .max(257)
  .refine((value) => {
    const parts = value.split(':')
    return parts.length <= 2 && parts.every((part) => PluginNameSchema.safeParse(part).success)
  }, 'Invalid starter reference')
export const PluginStarterActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), skill: StarterReference, prompt: LocalizedSchema }).strict(),
  z.object({ kind: z.literal('advisor'), framework: StarterReference, question: LocalizedSchema }).strict(),
  z.object({ kind: z.literal('work'), template: StarterReference }).strict(),
  z
    .object({ kind: z.literal('recipe'), recipe: StarterReference.optional(), recipeRef: PluginNameSchema.optional() })
    .strict()
    .refine((v) => !!v.recipe !== !!v.recipeRef, 'Choose recipe or recipeRef')
])
export const PluginStarterSchema = z
  .object({
    id: PluginNameSchema,
    title: LocalizedSchema,
    body: LocalizedSchema,
    action: PluginStarterActionSchema
  })
  .strict()
export const PluginStartersSchema = z
  .array(PluginStarterSchema)
  .max(30)
  .refine((items) => new Set(items.map((s) => s.id)).size === items.length, 'Duplicate starter id')
export type PluginStarter = z.infer<typeof PluginStarterSchema>
export const PluginSourcesSchema = z.object({
  feeds: z
    .array(
      z.object({
        url: z
          .url()
          .max(4096)
          .refine((v) => /^https?:\/\//.test(v)),
        title: z.string().min(1).max(200),
        kind: FeedKind
      })
    )
    .max(30)
})
export type PluginManifest = z.infer<typeof PluginManifestSchema>
export type MarketplaceEntry = z.infer<typeof MarketplaceEntrySchema>
export type PluginMcp = z.infer<typeof PluginMcpSchema>
export type JiweiExt = z.infer<typeof JiweiExtSchema>
export type PluginTemplate = z.infer<typeof PluginTemplateSchema>
export type PluginFramework = z.infer<typeof PluginFrameworkSchema>
export type PluginRecipe = z.infer<typeof PluginRecipeSchema>
export type PluginFeed = z.infer<typeof PluginSourcesSchema>['feeds'][number]
export type PluginSource = z.infer<typeof PluginSourceSchema>
export interface PluginCapabilities {
  servers: string[]
  domains: string[]
  commands: string[]
  sensitive: string[]
  feeds: string[]
  dataLeavesDevice: boolean
  cost: JiweiExt['cost']
  unsupported: string[]
}
export function inferCapabilities(plugin: {
  manifest: PluginManifest
  extension?: JiweiExt
  mcpServers: Record<string, PluginMcp>
  feeds: PluginFeed[]
  unsupported: string[]
}): PluginCapabilities {
  const unique = (v: string[]) => [...new Set(v)].sort()
  return {
    servers: Object.keys(plugin.mcpServers).sort(),
    domains: unique(
      Object.values(plugin.mcpServers).flatMap((s) => {
        if (!s.url) return []
        try {
          return [new URL(s.url).hostname]
        } catch {
          return [s.url]
        }
      })
    ),
    commands: unique(
      Object.values(plugin.mcpServers).flatMap((s) => (s.command ? [JSON.stringify([s.command, s.args, s.cwd ?? '', s.env])] : []))
    ),
    sensitive: Object.entries(plugin.manifest.userConfig ?? {})
      .filter(([, v]) => v.sensitive)
      .map(([k]) => k)
      .sort(),
    feeds: unique(plugin.feeds.map((f) => f.url)),
    dataLeavesDevice: plugin.extension?.dataLeavesDevice ?? false,
    cost: plugin.extension?.cost,
    unsupported: unique(plugin.unsupported)
  }
}
export function addedCapabilities(before: PluginCapabilities, after: PluginCapabilities): Partial<PluginCapabilities> {
  const result: Partial<PluginCapabilities> = {}
  for (const key of ['servers', 'domains', 'commands', 'sensitive', 'feeds'] as const) {
    const added = after[key].filter((v) => !before[key].includes(v))
    if (added.length) result[key] = added
  }
  if (after.dataLeavesDevice && !before.dataLeavesDevice) result.dataLeavesDevice = true
  if (after.cost && JSON.stringify(after.cost) !== JSON.stringify(before.cost)) result.cost = after.cost
  return result
}
export function resolvePluginVersion(input: { manifest?: string; entry?: string; sha?: string; hash: string }): string {
  return input.manifest || input.entry || input.sha?.slice(0, 12) || input.hash.slice(0, 12)
}
/** 小范围 semver：AND 比较、OR、^、~、通配符；未知语法明确拒绝而不绕过 engine。 */
export function satisfiesPluginEngine(range: string, version = PLUGIN_API_VERSION): boolean {
  const parse = (s: string): number[] | null => (/^\d+\.\d+\.\d+$/.test(s) ? s.split('.').map(Number) : null)
  const current = parse(version)
  if (!current) return false
  const cmp = (v: number[]) => current[0] - v[0] || current[1] - v[1] || current[2] - v[2]
  return range.split('||').some((group) => {
    const terms = group
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
      .split(/\s+/)
    return (
      terms.length > 0 &&
      terms.every((term) => {
        if (term === '*') return true
        const match = term.match(/^(>=|<=|>|<|=|\^|~)?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i)
        if (!match) return false
        const [, op = '=', major, minor, patch] = match,
          v = [Number(major), Number(minor) || 0, Number(patch) || 0]
        if (!minor || !patch || /[x*]/i.test(minor + patch))
          return !match[1] && current[0] === v[0] && (!minor || /[x*]/i.test(minor) || current[1] === v[1])
        const n = cmp(v)
        if (op === '^' || op === '~') {
          const upper = op === '~' ? [v[0], v[1] + 1, 0] : v[0] ? [v[0] + 1, 0, 0] : v[1] ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1]
          return n >= 0 && cmp(upper) < 0
        }
        return op === '>=' ? n >= 0 : op === '<=' ? n <= 0 : op === '>' ? n > 0 : op === '<' ? n < 0 : n === 0
      })
    )
  })
}

/** 来源由主进程获取器创建，绝不接受 renderer 自报 official/trustedBuiltin。 */
export interface PluginOrigin {
  /** main 识别的本地归档包装目录；更新必须复用此投影。 */
  subdir?: string
  selection?: string[]
  kind: 'local' | 'market' | 'github'
  market: string
  locator: string
  name?: string
}
export const PluginInspectSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('market'), market: MarketNameSchema, name: PluginNameSchema }),
  z.object({ kind: z.literal('github'), url: z.string().max(4096) })
])
export type PluginInspectInput = z.infer<typeof PluginInspectSource>
export const PluginConfigValues = z.record(
  PluginNameSchema,
  z.union([
    z.string().max(16000),
    z.number().finite(),
    z.boolean(),
    z.array(z.union([z.string().max(16000), z.number().finite()])).max(200),
    z.null()
  ])
)
export type PluginConfig = z.infer<typeof PluginConfigValues>
export const PluginConfirmOptions = z.object({
  feeds: z.array(z.number().int().min(0)).max(30).default([]),
  config: PluginConfigValues.default({})
})
export const PluginUninstallOptions = z.object({ removeFeeds: z.boolean().default(false), removeTasks: z.boolean().default(false) })
export interface PluginInfo {
  available: boolean
  id: string
  version: string
  previousVersion: string | null
  enabled: boolean
  origin: PluginOrigin
  manifest: PluginManifest
  capabilities: PluginCapabilities
  config: PluginConfig
  sensitive: Record<string, boolean>
  feeds: number
  tasks: number
}
export interface PluginPreview {
  category?: JiweiExt['category']
  token: string
  expiresAt: number
  id: string
  version: string
  origin: PluginOrigin
  manifest: PluginManifest
  capabilities: PluginCapabilities
  added: Partial<PluginCapabilities>
  skills: { name: string; kind: string; hasScripts: boolean }[]
  templates: PluginTemplate[]
  frameworks: PluginFramework[]
  recipes: PluginRecipe[]
  starters: PluginStarter[]
  feeds: PluginFeed[]
  scripts: string[]
  issues: { path: string; code: string; message: string }[]
}
export type PluginRegistryItem<T> = T & { pluginId?: string; source: 'builtin' | 'plugin' }

export const MarketInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), url: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('url'), url: z.string().url().max(4096).startsWith('https://') }).strict()
])
export type MarketInput = z.infer<typeof MarketInputSchema>
export interface PluginMarketInfo {
  name: string
  owner: string
  source: string
  builtin: boolean
  fetchedAt: number | null
  error: string | null
  count: number
}
export interface PluginCatalogCard {
  counts?: PluginContributionCounts
  icon?: string
  id: string
  name: string
  displayName: string
  description: string
  keywords: string[]
  author?: PluginManifest['author']
  category: NonNullable<JiweiExt['category']>
  localizedName?: JiweiExt['name']
  localizedDescription?: JiweiExt['description']
  origin: PluginOrigin
  sourceUrl?: string
  version?: string
  supported: boolean
  unsupportedReason?: string
  installedVersion?: string
  updateUnavailable: boolean
  updateAvailable: boolean
}
export interface PluginDetails {
  starters: PluginStarter[]
  sourceUrl?: string
  icon?: string
  preview?: PluginPreview
  installed?: PluginInfo
  readme: string
  unsupported: string[]
  contents: {
    skills: string[]
    templates: string[]
    frameworks: string[]
    recipes: string[]
    starters: string[]
    feeds: string[]
    mcp: string[]
  }
}
export type PluginDetection =
  | { kind: 'plugin'; preview: PluginPreview }
  | { kind: 'market'; token: string; name: string; owner: string; count: number }
  | { kind: 'skills'; token: string; name: string; skills: { path: string; name: string }[] }

/** strict:false 的显式技能集合是内容投影；同时保留显式命令与 MCP 文件。 */
export function marketplaceComponentSelection(entry?: MarketplaceEntry): string[] | undefined {
  if (entry?.strict !== false || !entry.skills) return undefined
  const paths = Array.isArray(entry.skills) ? [...entry.skills] : [entry.skills]
  if (typeof entry.commands === 'string') paths.push(entry.commands)
  else if (Array.isArray(entry.commands)) paths.push(...entry.commands)
  else if (entry.commands) for (const command of Object.values(entry.commands)) if (command.source) paths.push(command.source)
  for (const mcp of Array.isArray(entry.mcpServers) ? entry.mcpServers : [entry.mcpServers]) if (typeof mcp === 'string') paths.push(mcp)
  const normalized = [...new Set(paths.map(safeRelativePath))]
  return normalized.filter((p) => !normalized.some((parent) => parent !== p && (parent === '.' || p.startsWith(parent + '/'))))
}

/** 今日的安装级起步状态，仅由主进程投影。 */
export interface RoleStarters {
  pluginId: string
  name: { zh: string; en: string }
  installedAt: number
  starters: (PluginStarter & { completed: boolean })[]
}

export interface PluginContributionCounts {
  skills: number
  lenses: number
  templates: number
  frameworks: number
  recipes: number
  feeds: number
  starters: number
}
export interface RoleCatalogCard extends PluginCatalogCard {
  group: 'student' | 'work' | 'other'
  enabled: boolean | null
}
export type RoleBatchPreview = {
  token: string
  expiresAt: number
  roles: Omit<PluginPreview, 'token'>[]
  alreadyInstalled: string[]
}
export const RoleBatchSelections = z
  .array(
    z
      .object({
        id: z.string().min(1).max(257),
        options: PluginConfirmOptions
      })
      .strict()
  )
  .max(8)
  .refine((items) => new Set(items.map((x) => x.id)).size === items.length, 'Duplicate role')
export interface RoleBatchRecovery {
  selected: string[]
  installed: string[]
  remaining: string[]
  status: 'complete' | 'partial' | 'canceled' | 'interrupted'
  error?: string
}
