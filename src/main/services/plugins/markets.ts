import { app } from 'electron'
import { pluginIcon } from './icon'
import { eq } from 'drizzle-orm'
import { join, dirname, relative, basename } from 'path'
import { readdir, rm } from 'fs/promises'
import { getDb } from '../../db'
import { pluginMarkets, plugins } from '../../db/schema'
import { audit } from '../agent/audit'
import { emit } from '../../events'
import { pluginMutation, pluginRoot, readState } from './state'
import { parsePlugin, readPluginText, pluginContributionCounts } from './components'
import { safePluginPath, PLUGIN_LIMITS, preparePluginSource, inspectPluginFolder } from './sources'
import { AcquisitionBatch, githubSource, httpsUrl, sourceLink, type MarketSource } from './acquisition'
import { registerPluginSourceAdapter, uninstallPluginsForMarket, type PluginAcquisition } from './install'
import {
  parseMarketplace,
  marketplaceComponentSelection,
  pluginSourceSupport,
  safeRelativePath,
  type MarketplaceEntry,
  type PluginOrigin,
  type PluginCatalogCard,
  type PluginMarketInfo,
  type MarketInput,
  type PluginInspectInput,
  type PluginContributionCounts,
  type JiweiExt
} from '@shared/plugins'

export const OFFICIAL_MARKET = Object.freeze({ name: 'jiwei', bundled: 'resources/marketplace', remote: null as string | null })
let officialDefinition = OFFICIAL_MARKET
interface CatalogItem {
  counts?: PluginContributionCounts
  icon?: string
  entry: MarketplaceEntry
  source: MarketSource
  fallback?: MarketSource
  version?: string
  extension?: Pick<JiweiExt, 'category' | 'name' | 'description'>
  connector?: boolean
  metadata?: Pick<MarketplaceEntry, 'displayName' | 'description' | 'author' | 'keywords'>
}
interface Catalog {
  name: string
  owner: string
  items: CatalogItem[]
  officialRemote?: { identity: string; owner: string; items: CatalogItem[] }
}
const rowFor = (name: string) => getDb().select().from(pluginMarkets).where(eq(pluginMarkets.name, name)).get()
const rows = () => getDb().select().from(pluginMarkets).all()
const identity = (source: MarketSource) => JSON.stringify(source)
const officialSource = (): MarketSource => ({ kind: 'folder', path: join(app.getAppPath(), officialDefinition.bundled) })
const changed = () => emit('plugins:changed', {})
const record = (action: string, name: string) =>
  audit({ caller: 'app', tool: `plugins.${action}`, level: 'write', status: 'ok', summary: `${action}: ${name}` })

/** 返回 null 表示非可排序版本（提交/内容哈希）；不把词典顺序误当版本先后。 */
export function comparePluginVersions(a: string, b: string): number | null {
  if (a === b) return 0
  const parse = (v: string) =>
    /^(?:v)?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v)
  const aa = parse(a),
    bb = parse(b)
  if (!aa || !bb) return null
  for (let i = 1; i <= 3; i++) {
    const n = BigInt(aa[i] ?? 0) - BigInt(bb[i] ?? 0)
    if (n) return n > 0 ? 1 : -1
  }
  if (!aa[4] || !bb[4]) return aa[4] ? -1 : bb[4] ? 1 : 0
  const ap = aa[4].split('.'),
    bp = bb[4].split('.')
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue
    if (!ap[i] || !bp[i]) return ap[i] ? 1 : -1
    const an = /^\d+$/.test(ap[i]),
      bn = /^\d+$/.test(bp[i])
    if (an && bn) return BigInt(ap[i]) > BigInt(bp[i]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return ap[i] > bp[i] ? 1 : -1
  }
  return 0
}
async function loadCatalog(source: MarketSource, batch: AcquisitionBatch, official = false): Promise<Catalog> {
  const loaded =
    source.kind === 'github'
      ? await batch.catalog(source)
      : {
          raw: JSON.parse(
            source.kind === 'folder'
              ? await readPluginText(source.path, '.claude-plugin/marketplace.json')
              : await batch.text(httpsUrl(source.url))
          ),
          source
        }
  const parsed = parseMarketplace(loaded.raw, official)
  if (official && parsed.name !== OFFICIAL_MARKET.name) throw new Error('Official marketplace identity changed')
  return {
    name: parsed.name,
    owner: parsed.owner.name,
    items: parsed.plugins.map((entry) => ({
      entry:
        typeof entry.source === 'string' && parsed.metadata?.pluginRoot
          ? { ...entry, source: safeRelativePath(`${parsed.metadata.pluginRoot}/${entry.source}`) }
          : entry,
      source: loaded.source
    }))
  }
}
function pluginSourceLink(item: CatalogItem): string | undefined {
  const source = item.entry.source
  if (typeof source === 'string') {
    const parent = sourceLink(item.source)
    return item.source.kind === 'github' ? `${parent}${item.source.ref ? '' : '/tree/HEAD'}/${safeRelativePath(source)}` : parent
  }
  try {
    if (source.source === 'archive') return httpsUrl(source.url!)
    const parsed = githubSource(source.repo ?? source.url!)
    return sourceLink({ ...parsed, ref: source.ref ?? parsed.ref, subdir: source.path ?? parsed.subdir })
  } catch {
    return undefined
  }
}
async function acquireItem(
  item: CatalogItem,
  origin: PluginOrigin,
  batch: AcquisitionBatch,
  official: boolean
): Promise<PluginAcquisition> {
  const { entry, source } = item
  if (!pluginSourceSupport(entry.source).supported) throw new Error('积微暂不支持这种来源 / Unsupported plugin source')
  const options = { entry, trustedBuiltin: official }
  const selection = marketplaceComponentSelection(entry)
  if (typeof entry.source === 'string') {
    if (source.kind === 'folder') return { path: await safePluginPath(source.path, entry.source), type: 'folder', origin, options }
    if (source.kind !== 'github') throw new Error('URL marketplace cannot resolve relative plugin sources')
    const result = await batch.repository({ ...source, subdir: safeRelativePath(`${source.subdir ?? '.'}/${entry.source}`) }, selection)
    return {
      path: result.prepared.root,
      type: 'folder',
      origin,
      options: { ...options, sha: result.sha },
      cleanup: result.prepared.cleanup
    }
  }
  const value = entry.source
  if (value.source === 'archive')
    return { path: await batch.file(httpsUrl(value.url!), PLUGIN_LIMITS.archiveBytes), type: 'zip', origin, options }
  const github = githubSource(value.repo ?? value.url!)
  const result = await batch.repository(
    {
      ...github,
      ...(value.ref ? { ref: value.ref } : {}),
      ...(value.sha ? { sha: value.sha } : {}),
      ...(value.path ? { subdir: value.path } : {})
    },
    selection
  )
  return { path: result.prepared.root, type: 'folder', origin, options: { ...options, sha: result.sha }, cleanup: result.prepared.cleanup }
}
class CatalogEnrichmentError extends Error {}
async function enrich(catalog: Catalog, batch: AcquisitionBatch, official: boolean): Promise<void> {
  const failures: string[] = []
  for (const item of catalog.items) {
    batch.signal.throwIfAborted()
    if (!pluginSourceSupport(item.entry.source).supported || (typeof item.entry.source === 'string' && item.source.kind === 'url')) continue
    let acquired: PluginAcquisition | undefined, prepared: Awaited<ReturnType<typeof preparePluginSource>> | undefined
    try {
      acquired = await acquireItem(item, { kind: 'market', market: catalog.name, locator: '', name: item.entry.name }, batch, official)
      prepared = await preparePluginSource({ ...acquired, selection: marketplaceComponentSelection(item.entry) })
      const parsed = await parsePlugin(prepared.root, acquired.options)
      if (parsed.manifest.name !== item.entry.name) throw new Error('Marketplace plugin name mismatch')
      item.icon = await pluginIcon(parsed.root)
      item.version = parsed.version
      item.metadata = {
        displayName: parsed.manifest.displayName,
        description: parsed.manifest.description,
        author: parsed.manifest.author,
        keywords: parsed.manifest.keywords
      }
      item.counts = pluginContributionCounts(parsed)
      item.extension = parsed.extension
        ? { category: parsed.extension.category, name: parsed.extension.name, description: parsed.extension.description }
        : undefined
      item.connector = Object.keys(parsed.mcpServers).length > 0
    } catch {
      batch.signal.throwIfAborted()
      failures.push(item.entry.name)
    } finally {
      await prepared?.cleanup()
      await acquired?.cleanup?.()
    }
  }
  if (failures.length)
    throw new CatalogEnrichmentError(`插件获取或验证失败 / Plugin acquisition or validation failed: ${failures.join(', ')}`)
}
/** 只合并已完整校验的远程条目；缓存必须与当前 main 定义的远程来源严格匹配。 */
function mergeOfficial(bundled: Catalog, remote: Catalog['officialRemote']): Catalog {
  if (!remote) return bundled
  const merged = new Map(bundled.items.map((item) => [item.entry.name, item]))
  for (const item of remote.items) {
    const local = merged.get(item.entry.name)
    const compared = local ? comparePluginVersions(item.version ?? item.entry.version ?? '', local.version ?? local.entry.version ?? '') : 1
    if (!local || (compared !== null && compared >= 0)) merged.set(item.entry.name, { ...item, fallback: local?.source })
  }
  return { ...bundled, owner: remote.owner, items: [...merged.values()], officialRemote: remote }
}
function verifiedRemoteCache(cached: Catalog | undefined, definition: typeof OFFICIAL_MARKET): Catalog['officialRemote'] {
  if (!definition.remote || !cached?.officialRemote) return undefined
  return cached.officialRemote.identity === identity(githubSource(definition.remote)) ? cached.officialRemote : undefined
}
/** 参数只供 main 与隔离测试；renderer 无权配置官方来源。 */
export async function officialCatalog(
  batch: AcquisitionBatch,
  definition = officialDefinition,
  cached?: Catalog
): Promise<{ catalog: Catalog; error: string | null }> {
  const bundled = await loadCatalog({ kind: 'folder', path: join(app.getAppPath(), definition.bundled) }, batch, true)
  await enrich(bundled, batch, true)
  if (!definition.remote) return { catalog: bundled, error: null }
  try {
    const remote = await loadCatalog(githubSource(definition.remote), batch, true)
    await enrich(remote, batch, true)
    if (batch.rateLimited) throw new Error('GitHub rate limited')
    return {
      catalog: mergeOfficial(bundled, { identity: identity(githubSource(definition.remote)), owner: remote.owner, items: remote.items }),
      error: null
    }
  } catch (error) {
    batch.signal.throwIfAborted()
    return {
      catalog: mergeOfficial(bundled, verifiedRemoteCache(cached, definition)),
      error:
        error instanceof CatalogEnrichmentError
          ? `${error.message}; 使用缓存及内置版本 / using cached and bundled catalog`
          : '线上市场不可用，使用缓存及内置版本 / Remote unavailable; using cached and bundled catalog'
    }
  }
}
function publicMarket(row: ReturnType<typeof rows>[number]): PluginMarketInfo {
  const catalog: Catalog | null = row.catalog ? JSON.parse(row.catalog) : null
  return {
    name: row.name,
    owner: catalog?.owner ?? '',
    source: sourceLink(JSON.parse(row.source)),
    builtin: row.builtin,
    fetchedAt: row.fetchedAt,
    error: row.error,
    count: catalog?.items.length ?? 0
  }
}
export function listMarkets(): PluginMarketInfo[] {
  return rows().map(publicMarket)
}
export function catalogPlugins(): PluginCatalogCard[] {
  const installed = getDb().select().from(plugins).all()
  return rows().flatMap((row) => {
    const catalog: Catalog | null = row.catalog ? JSON.parse(row.catalog) : null
    return (catalog?.items ?? []).map((item) => {
      const entry = item.entry,
        id = `${entry.name}@${row.name}`,
        old = installed.find((p) => p.id === id)
      const supported = pluginSourceSupport(entry.source).supported && !(typeof entry.source === 'string' && item.source.kind === 'url')
      const version = item.version ?? entry.version
      const comparison = old && version ? comparePluginVersions(version, old.version) : 0
      // 同名市场被不同来源重新添加，不得让缓存更新提示绕过安装时绑定的来源。
      const updateUnavailable = !!old && readState(old.id).origin.locator !== row.source
      return {
        id,
        counts: item.counts,
        icon: item.icon,
        name: entry.name,
        displayName: item.metadata?.displayName ?? entry.displayName ?? entry.name,
        description: item.metadata?.description ?? entry.description ?? '',
        keywords: item.metadata?.keywords ?? entry.keywords ?? [],
        author: item.metadata?.author ?? entry.author,
        category: item.extension?.category ?? (item.connector || entry.mcpServers ? 'connector' : 'skills'),
        localizedName: item.extension?.name,
        localizedDescription: item.extension?.description,
        origin: { kind: 'market' as const, market: row.name, locator: row.source, name: entry.name },
        sourceUrl: pluginSourceLink(item),
        version,
        supported,
        unsupportedReason: supported ? undefined : '积微暂不支持这种来源 / Unsupported source',
        installedVersion: old?.version,
        updateUnavailable,
        updateAvailable: !!old && !updateUnavailable && !!version && (comparison === null ? version !== old.version : comparison > 0)
      }
    })
  })
}
async function refreshOne(name: string, batch: AcquisitionBatch): Promise<void> {
  batch.rateLimited = false
  const row = rowFor(name)
  if (!row) throw new Error('Marketplace not found')
  try {
    const result = row.builtin
      ? await officialCatalog(batch, officialDefinition, row.catalog ? JSON.parse(row.catalog) : undefined)
      : { catalog: await loadCatalog(JSON.parse(row.source), batch), error: null }
    if (result.catalog.name !== name) throw new Error('Marketplace identity changed')
    if (!row.builtin) await enrich(result.catalog, batch, false)
    if (batch.rateLimited && row.catalog) throw new Error('GitHub rate limited')
    getDb()
      .update(pluginMarkets)
      .set({ catalog: JSON.stringify(result.catalog), fetchedAt: result.error ? row.fetchedAt : Date.now(), error: result.error })
      .where(eq(pluginMarkets.name, name))
      .run()
  } catch (error) {
    batch.signal.throwIfAborted()
    // 失败仅更新错误；保留最后一次有效清单和时间，不持久化任意服务器错误正文。
    getDb()
      .update(pluginMarkets)
      .set({
        error: batch.rateLimited
          ? 'GitHub 请求受限，使用缓存，请稍后重试 / GitHub rate limited; using cached catalog'
          : error instanceof CatalogEnrichmentError
            ? error.message
            : '无法刷新市场，使用缓存 / Refresh failed; using cached catalog'
      })
      .where(eq(pluginMarkets.name, name))
      .run()
  }
}
export function refreshMarkets(name?: string, staleOnly = false): Promise<PluginMarketInfo[]> {
  return pluginMutation(async () => {
    const batch = new AcquisitionBatch(new AbortController().signal, 'market-refresh')
    try {
      for (const row of rows())
        if ((!name || row.name === name) && (!staleOnly || !row.fetchedAt || Date.now() - row.fetchedAt >= 86_400_000))
          await refreshOne(row.name, batch)
      changed()
      return listMarkets()
    } finally {
      await batch.cleanup()
    }
  })
}
export async function initializeMarkets(definition = OFFICIAL_MARKET): Promise<void> {
  if (definition.name !== OFFICIAL_MARKET.name) throw new Error('Invalid main official definition')
  if (definition.remote) githubSource(definition.remote)
  officialDefinition = definition
  registerPluginSourceAdapter(acquireMarketPlugin)
  const importRoot = join(pluginRoot(), 'market-imports')
  const retained = new Set(
    rows().map((row) => {
      const source = JSON.parse(row.source) as MarketSource
      return source.kind === 'folder' ? source.path : ''
    })
  )
  for (const name of await readdir(importRoot).catch(() => [])) {
    const path = join(importRoot, name, 'content')
    if (!retained.has(path)) await cleanupImport(path)
  }
  const source = identity(officialSource())
  const previous = rowFor(OFFICIAL_MARKET.name)
  const cached: Catalog | undefined = previous?.builtin && previous.catalog ? JSON.parse(previous.catalog) : undefined
  const remote = verifiedRemoteCache(cached, definition)
  getDb()
    .insert(pluginMarkets)
    .values({ name: OFFICIAL_MARKET.name, source, builtin: true, addedAt: Date.now() })
    .onConflictDoUpdate({ target: pluginMarkets.name, set: { source, builtin: true } })
    .run()
  // 启动只读取新应用的内置资源，不能冒充远程刷新，也不能丢弃已核查的远程缓存。
  const batch = new AcquisitionBatch(new AbortController().signal, 'official-market')
  try {
    const bundled = await loadCatalog(officialSource(), batch, true)
    await enrich(bundled, batch, true)
    getDb()
      .update(pluginMarkets)
      .set({
        catalog: JSON.stringify(mergeOfficial(bundled, remote)),
        fetchedAt: definition.remote ? (remote ? (previous?.fetchedAt ?? null) : null) : Date.now(),
        error: definition.remote && remote ? (previous?.error ?? null) : null
      })
      .where(eq(pluginMarkets.name, OFFICIAL_MARKET.name))
      .run()
  } finally {
    await batch.cleanup()
  }
}

export function addMarket(input: MarketInput): Promise<PluginMarketInfo> {
  return addMarketSource(input.kind === 'github' ? githubSource(input.url) : { kind: 'url', url: httpsUrl(input.url) })
}
/** 只供原生文件选择/有界识别 token 使用。 */
export function addMarketSource(source: MarketSource, context?: { signal: AbortSignal; id: string }): Promise<PluginMarketInfo> {
  return pluginMutation(async () => {
    const batch = new AcquisitionBatch(context?.signal ?? new AbortController().signal, context?.id ?? 'market-add')
    try {
      const catalog = await loadCatalog(source, batch)
      if (rows().some((r) => r.name.toLowerCase() === catalog.name.toLowerCase() || r.source === identity(source)))
        throw new Error('Marketplace name or source already exists / 市场名称或来源已存在')
      let enrichmentError: string | null = null
      try {
        await enrich(catalog, batch, false)
      } catch (error) {
        batch.signal.throwIfAborted()
        if (!(error instanceof CatalogEnrichmentError)) throw error
        enrichmentError = error.message
      }
      batch.signal.throwIfAborted()
      getDb().transaction(() => {
        getDb()
          .insert(pluginMarkets)
          .values({
            name: catalog.name,
            source: identity(source),
            builtin: false,
            catalog: JSON.stringify(catalog),
            fetchedAt: enrichmentError ? null : Date.now(),
            error:
              enrichmentError ??
              (batch.rateLimited ? 'GitHub 请求受限，部分版本使用内容摘要 / GitHub rate limited; content versions used' : null),
            addedAt: Date.now()
          })
          .run()
        record('addMarket', catalog.name)
      })
      changed()
      return publicMarket(rowFor(catalog.name)!)
    } finally {
      await batch.cleanup()
    }
  })
}
export async function removeMarket(name: string, options: { uninstall: boolean }): Promise<void> {
  let removedSource: MarketSource | undefined
  await uninstallPluginsForMarket(() => {
    const row = rowFor(name)
    if (!row || row.builtin || name === OFFICIAL_MARKET.name) throw new Error('Cannot remove built-in or missing marketplace')
    removedSource = JSON.parse(row.source) as MarketSource
    const ids = options.uninstall
      ? getDb()
          .select()
          .from(plugins)
          .where(eq(plugins.market, name))
          .all()
          .filter((p) => readState(p.id).origin.locator === row.source)
          .map((p) => p.id)
      : []
    return {
      ids,
      commit: () => {
        getDb().delete(pluginMarkets).where(eq(pluginMarkets.name, name)).run()
        record('removeMarket', name)
      }
    }
  })
  if (removedSource?.kind === 'folder') await cleanupImport(removedSource.path).catch(() => undefined)
}
async function cleanupImport(path: string): Promise<void> {
  const parent = join(pluginRoot(), 'market-imports'),
    container = dirname(path),
    name = relative(parent, container)
  if (!/^jiwei-plugin-[^/\\]+$/.test(name) || path !== join(container, 'content')) return
  await rm(await safePluginPath(parent, name), { recursive: true, force: true })
}
export function validateMarketOrigin(origin: PluginOrigin): void {
  if (origin.kind !== 'market') return
  const row = rowFor(origin.market)
  if (!row || row.source !== origin.locator) throw new Error('Marketplace removed or replaced; updates disabled / 市场已移除，无法更新')
}
export async function acquireMarketPlugin(
  input: PluginInspectInput | PluginOrigin,
  context?: { signal: AbortSignal; id: string; batch?: AcquisitionBatch }
): Promise<PluginAcquisition> {
  const signal = context?.signal ?? new AbortController().signal
  const batch = context?.batch ?? new AcquisitionBatch(signal, context?.id ?? 'plugin-download')
  const cleanupBatch = async (): Promise<void> => {
    if (!context?.batch) await batch.cleanup()
  }
  try {
    if (input.kind === 'github') {
      const source = githubSource('url' in input ? input.url : input.locator)
      const result = await batch.repository(source, 'selection' in input ? input.selection : undefined)
      const files = await inspectPluginFolder(result.prepared.root)
      if (
        files.includes('.claude-plugin/marketplace.json') ||
        (!('selection' in input && input.selection) &&
          !files.includes('.claude-plugin/plugin.json') &&
          !files.includes('SKILL.md') &&
          !files.some((p) => p.startsWith('skills/')))
      ) {
        await result.prepared.cleanup()
        throw new Error('Use source detection to add a marketplace or select Agent Skills / 请先识别市场或选择技能')
      }
      return {
        path: result.prepared.root,
        type: 'folder',
        origin: {
          kind: 'github',
          market: 'local',
          locator: sourceLink(source),
          ...('selection' in input ? { selection: input.selection } : {})
        },
        options: {
          sha: result.sha,
          ...(!files.includes('.claude-plugin/plugin.json')
            ? { entry: { name: basename(source.subdir ?? source.repo), source: '.', strict: true } }
            : {})
        },
        cleanup: async () => {
          await result.prepared.cleanup()
          await cleanupBatch()
        }
      }
    }
    if (input.kind !== 'market') throw new Error('Invalid marketplace source')
    if ('locator' in input) validateMarketOrigin(input)
    const row = rowFor(input.market)
    if (!row?.catalog) throw new Error('Marketplace unavailable')
    const catalog: Catalog = JSON.parse(row.catalog),
      item = catalog.items.find((p) => p.entry.name === input.name)
    if (!item) throw new Error('Plugin no longer in marketplace')
    const origin: PluginOrigin = { kind: 'market', market: row.name, name: item.entry.name, locator: row.source }
    let acquired: PluginAcquisition
    try {
      acquired = await acquireItem(item, origin, batch, row.builtin && row.name === OFFICIAL_MARKET.name)
    } catch (error) {
      signal.throwIfAborted()
      if (!row.builtin || !item.fallback) throw error
      // fallback 使用内置清单的完整 entry，不能把线上路径套进内置资源。
      const bundled = await loadCatalog(item.fallback, batch, true),
        local = bundled.items.find((p) => p.entry.name === item.entry.name)
      if (!local) throw error
      acquired = await acquireItem(local, origin, batch, true)
    }
    const cleanup = acquired.cleanup
    return {
      ...acquired,
      cleanup: async () => {
        await cleanup?.()
        await cleanupBatch()
      }
    }
  } catch (error) {
    await cleanupBatch()
    throw error
  }
}
