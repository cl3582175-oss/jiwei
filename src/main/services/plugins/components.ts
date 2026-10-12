import { constants } from 'fs'
import { lstat, open, readdir } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { createHash } from 'crypto'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  PluginManifestSchema,
  MarketplaceEntrySchema,
  JiweiExtSchema,
  PluginTemplateSchema,
  PluginFrameworkSchema,
  PluginRecipeSchema,
  PluginStartersSchema,
  PluginSourcesSchema,
  PluginMcpMapSchema,
  PluginMcpSchema,
  PluginNameSchema,
  inferCapabilities,
  resolvePluginVersion,
  satisfiesPluginEngine,
  safeRelativePath,
  type MarketplaceEntry,
  type PluginManifest,
  type JiweiExt,
  type PluginTemplate,
  type PluginFramework,
  type PluginRecipe,
  type PluginStarter,
  type PluginFeed,
  type PluginMcp,
  type PluginCapabilities
} from '@shared/plugins'
import { parseSkill, type ParsedSkill } from '../../lib/skillFormat'
import { validateLensMetadata } from '../../lib/lensSkill'
import { taskRecipes } from '@shared/taskRecipes'
import { inspectPluginFolder, safePluginPath, PLUGIN_LIMITS } from './sources'

export interface PluginIssue {
  path: string
  code: 'invalid_component' | 'unknown_field' | 'unsupported'
  message: string
}
export interface PluginSkill extends ParsedSkill {
  localName: string
  dir: string
  file: string | null
  hash: string
  hasScripts: boolean
}
export interface ParsedPlugin {
  root: string
  manifest: PluginManifest
  extension?: JiweiExt
  version: string
  hash: string
  skills: PluginSkill[]
  templates: PluginTemplate[]
  frameworks: PluginFramework[]
  recipes: PluginRecipe[]
  starters: PluginStarter[]
  feeds: PluginFeed[]
  mcpServers: Record<string, PluginMcp>
  unsupported: string[]
  scripts: string[]
  issues: PluginIssue[]
  capabilities: PluginCapabilities
  icon: string | null
}
export interface ParsePluginOptions {
  entry?: MarketplaceEntry
  trustedBuiltin?: boolean
  sha?: string
}
export async function readPluginText(root: string, relative: string): Promise<string> {
  const file = await safePluginPath(root, relative),
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.size > PLUGIN_LIMITS.textBytes) throw new Error('Plugin text limit exceeded')
    // 固定最多读取上限加一字节；文件在 stat 后增长也不会无限分配。
    const buffer = Buffer.alloc(PLUGIN_LIMITS.textBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size > PLUGIN_LIMITS.textBytes) throw new Error('Plugin actual text limit exceeded')
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    await handle.close()
  }
}
const hashText = (s: string) => createHash('sha256').update(s).digest('hex')
const list = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const script = (p: string) => /\.(py|sh|bash|zsh|js|mjs|cjs|ts|ps1|bat|cmd|exe|dll|so|dylib)$/i.test(p)
export async function parsePlugin(root: string, options: ParsePluginOptions = {}): Promise<ParsedPlugin> {
  const files = await inspectPluginFolder(root),
    issues: PluginIssue[] = [],
    unsupported = new Set<string>(),
    skills: PluginSkill[] = []
  const json = async (file: string) => JSON.parse(await readPluginText(root, file)) as unknown
  const hasManifest = files.includes('.claude-plugin/plugin.json'),
    entry = options.entry ? MarketplaceEntrySchema.parse(options.entry) : undefined
  if (
    hasManifest &&
    entry?.strict === false &&
    ['skills', 'commands', 'mcpServers', 'agents', 'hooks', 'lspServers', 'outputStyles'].some((key) => Object.hasOwn(entry, key))
  )
    throw new Error('strict:false entry conflicts with plugin manifest components')
  const rawManifest = hasManifest ? await json('.claude-plugin/plugin.json') : (entry ?? { name: basename(root) })
  const manifest = PluginManifestSchema.parse(rawManifest)
  // strict 条目的组件补充 manifest；skills 追加，commands 明示替换，MCP 按顺序合并。
  if (hasManifest && entry) {
    if (entry.skills) manifest.skills = [...list(manifest.skills), ...list(entry.skills)]
    if (entry.commands) manifest.commands = entry.commands
    if (entry.mcpServers)
      manifest.mcpServers = [
        ...(Array.isArray(manifest.mcpServers) ? manifest.mcpServers : manifest.mcpServers ? [manifest.mcpServers] : []),
        ...(Array.isArray(entry.mcpServers) ? entry.mcpServers : [entry.mcpServers])
      ]
  }
  let extension: JiweiExt | undefined
  if (files.includes('jiwei/manifest.json')) {
    const raw = await json('jiwei/manifest.json')
    extension = JiweiExtSchema.parse(raw)
    for (const key of Object.keys(raw as object))
      if (!Object.hasOwn(JiweiExtSchema.shape, key))
        issues.push({ path: 'jiwei/manifest.json', code: 'unknown_field', message: `Unknown field: ${key}` })
    if (extension.engines && !satisfiesPluginEngine(extension.engines.jiwei)) throw new Error('Incompatible plugin engine')
    extension.renderers = extension.renderers.filter((renderer) => {
      if (options.trustedBuiltin && renderer === 'manim') return true
      unsupported.add(`renderer:${renderer}`)
      return false
    })
  }
  for (const name of ['agents', 'hooks', 'lspServers', 'outputStyles', 'themes', 'monitors', 'workflows', 'bin']) {
    const dir = name === 'outputStyles' ? 'output-styles' : name === 'lspServers' ? '.lsp.json' : name
    if (manifest[name as keyof PluginManifest] !== undefined || files.some((p) => p === dir || p.startsWith(dir + '/')))
      unsupported.add(name)
  }
  const attempt = async (file: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (e) {
      issues.push({ path: file, code: 'invalid_component', message: e instanceof Error ? e.message : 'Invalid component' })
    }
  }
  const loaded = new Set<string>()
  const addSkill = async (file: string, lens = false, rootSkill = false) => {
    if (loaded.has(file)) return
    loaded.add(file)
    await attempt(file, async () => {
      const text = await readPluginText(root, file),
        parsed = parseSkill(text, rootSkill ? undefined : basename(dirname(file)))
      if (lens || parsed.metadata.kind === 'lens') validateLensMetadata(parsed.metadata)
      const dir = await safePluginPath(root, dirname(file)),
        name = `${manifest.name}:${parsed.name}`
      if (skills.some((s) => s.name === name)) throw new Error('Duplicate skill name')
      skills.push({
        ...parsed,
        name,
        localName: parsed.name,
        dir,
        file: await safePluginPath(root, file),
        hash: hashText(text),
        hasScripts: files.some((p) => (dirname(file) === '.' || p.startsWith(dirname(file) + '/')) && script(p))
      })
    })
  }
  const scanSkills = async (path: string, lens = false) => {
    const full = await safePluginPath(root, path)
    let stat
    try {
      stat = await lstat(full)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    if (!stat.isDirectory()) throw new Error('Skills path must be directory')
    const prefix = safeRelativePath(path).replace(/^\.$/, '')
    const own = prefix ? `${prefix}/SKILL.md` : 'SKILL.md'
    if (files.includes(own)) await addSkill(own, lens, !prefix)
    else
      for (const d of await readdir(full, { withFileTypes: true }))
        if (d.isDirectory()) {
          const file = join(prefix, d.name, 'SKILL.md')
          if (files.includes(file)) await addSkill(file, lens)
        }
  }
  const selectedOnly = !hasManifest && !!entry?.skills
  if (!selectedOnly) {
    await scanSkills('skills')
    if (files.includes('SKILL.md')) await addSkill('SKILL.md', false, true)
  }
  for (const path of list(manifest.skills)) await scanSkills(path)
  await scanSkills('jiwei/lenses', true)
  const addCommand = async (name: string, text: string, file: string | null, description?: string) => {
    PluginNameSchema.parse(name)
    let body = text,
      meta: Record<string, unknown> = {}
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (match) {
      meta = z.record(z.string(), z.unknown()).parse(parseYaml(match[1]))
      body = match[2]
    }
    const id = `${manifest.name}:${name}`
    if (skills.some((s) => s.name === id)) throw new Error('Duplicate command name')
    skills.push({
      name: id,
      localName: name,
      description: String(description ?? meta.description ?? name).slice(0, 1024),
      license: null,
      metadata: { kind: 'command' },
      body: body.replaceAll('$ARGUMENTS', '用户本次的要求 / the user’s current request'),
      dir: file ? dirname(await safePluginPath(root, file)) : root,
      file: file ? await safePluginPath(root, file) : null,
      hash: hashText(text),
      hasScripts: files.some((p) => (file === null || dirname(file) === '.' || p.startsWith(dirname(file) + '/')) && script(p))
    })
  }
  const commands = manifest.commands ?? 'commands'
  if (typeof commands === 'string' || Array.isArray(commands)) {
    for (const path of list(commands)) {
      const full = await safePluginPath(root, path)
      let st
      try {
        st = await lstat(full)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
      const commandFiles = st.isDirectory() ? (await readdir(full)).filter((n) => n.endsWith('.md')).map((n) => join(path, n)) : [path]
      for (const file of commandFiles)
        await attempt(file, async () => addCommand(basename(file, '.md'), await readPluginText(root, file), file))
    }
  } else
    for (const [name, command] of Object.entries(commands))
      await attempt(command.source ?? name, async () =>
        addCommand(name, command.content ?? (await readPluginText(root, command.source!)), command.source ?? null, command.description)
      )
  const mcpServers: Record<string, PluginMcp> = {}
  const mergeMcp = async (part: string | Record<string, PluginMcp>) => {
    if (typeof part === 'string' && /\.(mcpb|dxt)$/i.test(part)) {
      await safePluginPath(root, part)
      unsupported.add(part)
      return
    }
    const raw = typeof part === 'string' ? await json(part) : part
    const body = raw && typeof raw === 'object' && Object.hasOwn(raw, 'mcpServers') ? (raw as { mcpServers: unknown }).mcpServers : raw
    Object.assign(mcpServers, PluginMcpMapSchema.parse(body))
  }
  if (files.includes('.mcp.json')) await attempt('.mcp.json', () => mergeMcp('.mcp.json'))
  for (const part of Array.isArray(manifest.mcpServers) ? manifest.mcpServers : manifest.mcpServers ? [manifest.mcpServers] : [])
    await attempt(typeof part === 'string' ? part : 'mcpServers', () => mergeMcp(part))
  for (const [name, server] of Object.entries(mcpServers)) if (server.type === 'sse') unsupported.add(`mcp:sse:${name}`)
  const components = async <T>(folder: string, schema: z.ZodType<T>): Promise<T[]> => {
    const result: T[] = [],
      ids = new Set<string>()
    for (const file of files.filter((p) => dirname(p) === folder && p.endsWith('.json')))
      await attempt(file, async () => {
        const item = schema.parse(await json(file)),
          id = (item as { id: string }).id
        if (ids.has(id)) throw new Error('Duplicate component id')
        ids.add(id)
        result.push(item)
      })
    return result
  }
  const templates = await components('jiwei/templates', PluginTemplateSchema),
    frameworks = await components('jiwei/frameworks', PluginFrameworkSchema),
    recipes = await components('jiwei/recipes', PluginRecipeSchema)
  let starters: PluginStarter[] = []
  if (files.includes('jiwei/starters.json'))
    await attempt('jiwei/starters.json', async () => {
      const own = (reference: string, ids: string[]) => {
        const prefix = `${manifest.name}:`,
          local = reference.startsWith(prefix) ? reference.slice(prefix.length) : reference
        if (!ids.includes(local)) throw new Error('Starter references an unavailable own contribution')
        return prefix + local
      }
      // 全部引用验证通过才发布，避免部分有效的卡片掩盖资源包损坏。
      starters = PluginStartersSchema.parse(await json('jiwei/starters.json')).map((starter) => {
        const a = starter.action
        if (a.kind === 'chat')
          return {
            ...starter,
            action: {
              ...a,
              skill: own(
                a.skill,
                skills.filter((s) => s.metadata.kind !== 'lens').map((s) => s.localName)
              )
            }
          }
        if (a.kind === 'advisor')
          return {
            ...starter,
            action: {
              ...a,
              framework: own(
                a.framework,
                frameworks.map((f) => f.id)
              )
            }
          }
        if (a.kind === 'work')
          return {
            ...starter,
            action: {
              ...a,
              template: own(
                a.template,
                templates.map((t) => t.id)
              )
            }
          }
        if (a.recipe)
          return {
            ...starter,
            action: {
              ...a,
              recipe: own(
                a.recipe,
                recipes.map((r) => r.id)
              )
            }
          }
        if (!taskRecipes.some((r) => r.id === a.recipeRef)) throw new Error('Unknown builtin recipe reference')
        return starter
      })
    })
  let feeds: PluginFeed[] = []
  if (files.includes('jiwei/sources.json'))
    await attempt('jiwei/sources.json', async () => {
      feeds = PluginSourcesSchema.parse(await json('jiwei/sources.json')).feeds
    })
  let icon: string | null = null
  if (files.includes('jiwei/icon.png'))
    await attempt('jiwei/icon.png', async () => {
      const path = await safePluginPath(root, 'jiwei/icon.png'),
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const header = Buffer.alloc(24),
          stat = await handle.stat(),
          { bytesRead } = await handle.read(header, 0, 24, 0)
        if (
          stat.size > 100 * 1024 ||
          bytesRead < 24 ||
          !header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          header.toString('ascii', 12, 16) !== 'IHDR' ||
          !header.readUInt32BE(16) ||
          !header.readUInt32BE(20) ||
          header.readUInt32BE(16) > 256 ||
          header.readUInt32BE(20) > 256
        )
          throw new Error('Invalid plugin icon dimensions or size')
        icon = path
      } finally {
        await handle.close()
      }
    })
  const hash = createHash('sha256')
  let total = 0
  for (const file of files) {
    const handle = await open(await safePluginPath(root, file), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      hash.update(JSON.stringify([file, stat.size])).update('\0')
      let size = 0
      for await (const chunk of handle.createReadStream()) {
        size += chunk.length
        total += chunk.length
        if (size > stat.size || total > PLUGIN_LIMITS.bytes) throw new Error('Plugin changed during parsing or exceeds size limit')
        hash.update(chunk)
      }
      if (size !== stat.size) throw new Error('Plugin changed during parsing')
    } finally {
      await handle.close()
    }
  }
  const digest = hash.digest('hex'),
    unsupportedList = [...unsupported].sort()
  const result = {
    root,
    manifest,
    extension,
    skills,
    templates,
    frameworks,
    recipes,
    starters,
    feeds,
    mcpServers,
    unsupported: unsupportedList,
    scripts: files.filter(script),
    issues,
    hash: digest,
    version: resolvePluginVersion({ manifest: manifest.version, entry: entry?.version, sha: options.sha, hash: digest })
  }
  return { ...result, icon, capabilities: inferCapabilities(result) }
}
/** 仅连接时使用；结果不可持久化、写日志或返回 renderer。缺少配置明确拒绝。 */
export function resolvePluginMcp(
  server: PluginMcp,
  context: { root: string; data: string; userConfig: Record<string, unknown> }
): PluginMcp {
  const replace = (text: string) =>
    text.replace(/\$\{([^}]+)\}/g, (_all, key: string) => {
      if (key === 'CLAUDE_PLUGIN_ROOT') return context.root
      if (key === 'CLAUDE_PLUGIN_DATA') return context.data
      if (key.startsWith('user_config.')) {
        const name = key.slice(12)
        if (!Object.hasOwn(context.userConfig, name) || context.userConfig[name] === undefined || context.userConfig[name] === null)
          throw new Error('Missing plugin user configuration')
        const value = context.userConfig[name]
        if (['string', 'number', 'boolean'].includes(typeof value)) return String(value)
        if (Array.isArray(value) && value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) return value.join(',')
        throw new Error('Invalid plugin user configuration')
      }
      throw new Error('Unsupported MCP placeholder')
    })
  const map = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
  return PluginMcpSchema.parse({
    ...server,
    command: server.command ? replace(server.command) : undefined,
    args: server.args.map(replace),
    cwd: server.cwd ? replace(server.cwd) : undefined,
    url: server.url ? replace(server.url) : undefined,
    env: map(server.env),
    headers: map(server.headers)
  })
}
