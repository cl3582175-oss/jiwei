import { tr } from '../../lib/messages'
import { sourceLink, type MarketSource, type AcquisitionBatch } from './acquisition'
import { pluginIcon } from './icon'
import { dialog, shell, type BrowserWindow } from 'electron'
import { randomBytes } from 'crypto'
import { mkdir, readdir, rm, rename, writeFile, readFile, lstat } from 'fs/promises'
import { existsSync, renameSync } from 'fs'
import { join, relative } from 'path'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { plugins, pluginMarkets, feeds, aiTasks, mcpServers, meta } from '../../db/schema'
import { newId } from '../../lib/ids'
import { emit } from '../../events'
import { audit } from '../agent/audit'
import { saveFeed, removeFeed } from '../discover/feeds'
import { removeTask } from '../tasks/service'
import { disconnect, connectServer, listServers } from '../mcp/client'
import { parsePlugin, readPluginText, type ParsedPlugin, type ParsePluginOptions } from './components'
import { preparePluginSource, safePluginPath, sourceType } from './sources'
import { registeredPlugin, replacePluginRegistry } from './registry'
import {
  pluginRoot,
  pluginCache,
  pluginData,
  pluginRow,
  readState,
  writeState,
  stateKey,
  pluginMutation,
  type InstalledVersion
} from './state'
import { prepareConfig, disablePluginMcpRows } from './config'
import {
  addedCapabilities,
  marketplaceComponentSelection,
  PluginConfirmOptions,
  type PluginInfo,
  type PluginOrigin,
  type PluginPreview,
  type PluginInspectInput,
  type PluginConfig,
  type PluginDetails
} from '@shared/plugins'

export interface PluginAcquisition {
  progressId?: string
  path: string
  type: 'folder' | 'zip' | 'tar.gz'
  subdir?: string
  origin: PluginOrigin
  options?: ParsePluginOptions
  cleanup?: () => Promise<void>
}
/** P2 注册主进程来源适配器。它必须验证市场身份并获取真实 source，不接受 renderer 的信任位。 */
let acquire:
  | ((
      input: PluginInspectInput | PluginOrigin,
      context?: { signal: AbortSignal; id: string; batch?: AcquisitionBatch }
    ) => Promise<PluginAcquisition>)
  | undefined
export function registerPluginSourceAdapter(adapter: NonNullable<typeof acquire>): void {
  acquire = adapter
}
interface Pending {
  prepared: Awaited<ReturnType<typeof preparePluginSource>>
  parsed: ParsedPlugin
  origin: PluginOrigin
  options: ParsePluginOptions
  expected: string | null
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}
const previews = new Map<string, Pending>()
const installing = new Map<string, { canceled: boolean; committed: boolean }>()
const PREVIEW_MS = 10 * 60_000
const notify = (): void => {
  for (const event of ['plugins:changed', 'mcp:changed', 'discover:changed', 'tasks:changed'] as const) {
    try {
      emit(event, {})
    } catch {
      /* 通知失败不能撤销已经提交的数据，下一次查询读取真实状态。 */
    }
  }
}
const record = (action: string, id: string): void =>
  audit({ caller: 'app', tool: `plugins.${action}`, level: 'write', status: 'ok', summary: `${action}: ${id}` })
async function owned(path: string): Promise<string> {
  await mkdir(pluginRoot(), { recursive: true })
  return safePluginPath(pluginRoot(), relative(pluginRoot(), path) || '.')
}
function safeManifest(parsed: ParsedPlugin) {
  // 敏感默认值不进入 UI，亦不会自动启用；用户配置只通过专门的密文路径保存。
  // 积微扩展里有中英文名称和简介时，按界面语言显示（Claude 格式只有一种语言）
  const ext = parsed.extension
  return {
    ...parsed.manifest,
    ...(ext?.name ? { displayName: tr(ext.name.zh, ext.name.en) } : {}),
    ...(ext?.description ? { description: tr(ext.description.zh, ext.description.en) } : {}),
    userConfig: Object.fromEntries(
      Object.entries(parsed.manifest.userConfig ?? {}).map(([k, v]) => [k, v.sensitive ? { ...v, default: undefined } : v])
    )
  }
}
export function getPlugin(id: string): PluginInfo {
  const row = pluginRow(id),
    state = readState(id),
    parsed = registeredPlugin(id)
  return {
    id,
    version: row.version,
    previousVersion: row.previousVersion,
    enabled: row.enabled,
    origin: state.origin,
    available: !!parsed,
    manifest: parsed ? safeManifest(parsed) : { name: id.split('@')[0] },
    capabilities: JSON.parse(row.capabilities),
    config: JSON.parse(row.config),
    sensitive: Object.fromEntries(
      Object.entries(parsed?.manifest.userConfig ?? {})
        .filter(([, v]) => v.sensitive)
        .map(([k]) => [k, state.secretKeys.includes(k)])
    ),
    feeds: getDb()
      .select()
      .from(feeds)
      .where(eq(feeds.pluginId, id))
      .all()
      .filter((r) => !r.deletedAt).length,
    tasks: getDb()
      .select()
      .from(aiTasks)
      .where(eq(aiTasks.pluginId, id))
      .all()
      .filter((r) => !r.deletedAt).length
  }
}
export function listPlugins(): PluginInfo[] {
  return getDb()
    .select()
    .from(plugins)
    .all()
    .map((r) => getPlugin(r.id))
}
export async function inspectAcquired(input: PluginAcquisition, updateId?: string, signal?: AbortSignal): Promise<PluginPreview> {
  const parent = await owned(join(pluginRoot(), 'previews'))
  await mkdir(parent, { recursive: true })
  let prepared: Pending['prepared'] | undefined
  try {
    emit('plugins:progress', { id: input.progressId ?? input.origin.name ?? 'preview', phase: 'verify' })
    const entry = input.options?.entry
    const selection = input.origin.selection ?? marketplaceComponentSelection(entry)
    prepared = await preparePluginSource({ ...input, selection, tempParent: parent })
    const options = input.options ?? {},
      parsed = await parsePlugin(prepared.root, options)
    signal?.throwIfAborted()
    if (input.origin.name && input.origin.name !== parsed.manifest.name) throw new Error('Marketplace plugin name mismatch')
    const id = `${parsed.manifest.name}@${input.origin.market}`
    if (updateId && updateId !== id) throw new Error('Updated plugin identity changed')
    // 两个市场不能悄悄覆盖同一技能 namespace。
    const rows = getDb().select().from(plugins).all()
    if (rows.some((r) => r.id !== id && r.id.split('@')[0] === parsed.manifest.name))
      throw new Error('Plugin namespace already installed from another market')
    const old = rows.find((r) => r.id === id)
    if (old && !updateId) throw new Error('Plugin already installed; use update')
    const token = randomBytes(32).toString('hex'),
      expiresAt = Date.now() + PREVIEW_MS
    const timer = setTimeout(() => {
      void cancelPluginPreview(token).catch(() => undefined)
    }, PREVIEW_MS)
    timer.unref()
    previews.set(token, {
      prepared,
      parsed,
      origin: input.origin,
      options,
      expected: old ? readState(id).current.directory : null,
      expiresAt,
      timer
    })
    return {
      token,
      category: parsed.extension?.category,
      expiresAt,
      id,
      version: parsed.version,
      origin: input.origin,
      manifest: safeManifest(parsed),
      capabilities: parsed.capabilities,
      added: old ? addedCapabilities(JSON.parse(old.capabilities), parsed.capabilities) : parsed.capabilities,
      skills: parsed.skills.map((s) => ({ name: s.name, kind: s.metadata.kind ?? 'skill', hasScripts: s.hasScripts })),
      templates: parsed.templates,
      frameworks: parsed.frameworks,
      recipes: parsed.recipes,
      starters: parsed.starters,
      feeds: parsed.feeds,
      scripts: parsed.scripts,
      issues: parsed.issues
    }
  } catch (e) {
    await prepared?.cleanup()
    throw e
  } finally {
    await input.cleanup?.().catch(() => undefined)
  }
}
/** 仅 main 内部 / 原生文件选择器可调用。IPC 测试入口另受开发环境开关限制。 */
export function inspectPluginPath(path: string): Promise<PluginPreview> {
  return pluginMutation(() => inspectAcquired({ path, type: sourceType(path), origin: { kind: 'local', market: 'local', locator: path } }))
}
export function inspectPlugin(
  input: PluginInspectInput,
  context?: { signal: AbortSignal; id: string; batch?: AcquisitionBatch }
): Promise<PluginPreview> {
  return pluginMutation(async () => {
    if (!acquire) throw new Error('Plugin source adapter unavailable')
    return inspectAcquired({ ...(await acquire(input, context)), progressId: context?.id }, undefined, context?.signal)
  })
}
export function updatePlugin(id: string, context?: { signal: AbortSignal; id: string; batch?: AcquisitionBatch }): Promise<PluginPreview> {
  return pluginMutation(async () => {
    const state = readState(id),
      origin = state.origin
    if (origin.kind === 'local')
      return inspectAcquired(
        {
          path: origin.locator,
          type: sourceType(origin.locator),
          subdir: origin.subdir,
          origin,
          options: state.current.options,
          progressId: context?.id
        },
        id,
        context?.signal
      )
    if (!acquire) throw new Error('Plugin source adapter unavailable')
    const acquired = await acquire(origin, context)
    if (origin.selection) acquired.options = { ...acquired.options, entry: state.current.options.entry }
    return inspectAcquired({ ...acquired, progressId: context?.id }, id, context?.signal)
  })
}
export async function installPluginFromFile(win: BrowserWindow | null): Promise<PluginPreview | null> {
  const opts = {
    properties: ['openFile', 'openDirectory'] as ('openFile' | 'openDirectory')[],
    filters: [{ name: 'Plugin', extensions: ['zip', 'gz'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return result.canceled || !result.filePaths[0] ? null : inspectPluginPath(result.filePaths[0])
}
export async function cancelPluginPreview(token: string): Promise<void> {
  const active = installing.get(token)
  if (active && !active.committed) {
    active.canceled = true
    return
  }
  const pending = previews.get(token)
  if (!pending) return
  previews.delete(token)
  clearTimeout(pending.timer)
  await pending.prepared.cleanup()
}
async function disconnectPlugin(id: string): Promise<void> {
  for (const row of getDb().select().from(mcpServers).where(eq(mcpServers.pluginId, id)).all()) await disconnect(row.id)
}
function writeMcp(id: string, parsed: ParsedPlugin): void {
  const db = getDb(),
    old = db.select().from(mcpServers).where(eq(mcpServers.pluginId, id)).all()
  db.delete(mcpServers).where(eq(mcpServers.pluginId, id)).run()
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    // 既有客户端仅支持 Streamable HTTP，不能把旧 SSE endpoint 冒充 http。
    if (server.type === 'sse') continue
    const previous = old.find((r) => r.name === name)
    db.insert(mcpServers)
      .values({
        id: previous?.id ?? newId(),
        pluginId: id,
        name,
        transport: server.command ? 'stdio' : 'http',
        command: server.command ?? null,
        args: JSON.stringify(server.args),
        cwd: server.cwd ?? null,
        url: server.url ?? null,
        enabled: false,
        toolPolicies: previous?.toolPolicies ?? '{}',
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now()
      })
      .run()
  }
}
async function cleanupVersions(id: string): Promise<void> {
  const state = readState(id),
    keep = new Set([state.current.directory, state.previous?.directory])
  const root = await owned(pluginCache(id))
  for (const child of await readdir(root).catch(() => [])) {
    const path = await owned(join(root, child))
    if (!keep.has(path)) await rm(path, { recursive: true, force: true })
  }
}
export async function confirmPluginInstall(token: string, input: { feeds?: number[]; config?: PluginConfig }): Promise<PluginInfo> {
  const recovery: { pluginId: string; directory: string; serverId: string }[] = []
  try {
    return await pluginMutation(async () => {
      const pending = previews.get(token)
      if (!pending) throw new Error('Invalid or already used plugin preview')
      previews.delete(token)
      clearTimeout(pending.timer)
      const active = { canceled: false, committed: false }
      installing.set(token, active)
      const checkCanceled = (): void => {
        if (active.canceled) throw new Error('Plugin installation canceled / 插件安装已取消')
      }
      let reconnect: typeof recovery = []
      let target: string | undefined,
        newIdForCleanup: string | undefined,
        committed = false
      try {
        if (pending.origin.kind === 'market') {
          const market = getDb().select().from(pluginMarkets).where(eq(pluginMarkets.name, pending.origin.market)).get()
          if (!market || market.source !== pending.origin.locator) throw new Error('Marketplace removed or replaced; inspect again')
        }
        if (Date.now() >= pending.expiresAt) throw new Error('Plugin preview expired; inspect again')
        const opts = PluginConfirmOptions.parse(input),
          parsed = await parsePlugin(pending.prepared.root, pending.options),
          id = `${parsed.manifest.name}@${pending.origin.market}`
        checkCanceled()
        if (parsed.hash !== pending.parsed.hash) throw new Error('Plugin changed after preview; inspect again')
        const rows = getDb().select().from(plugins).all()
        if (rows.some((r) => r.id !== id && r.id.split('@')[0] === parsed.manifest.name))
          throw new Error('Plugin namespace already installed from another market')
        const old = rows.find((r) => r.id === id),
          oldState = old ? readState(id) : undefined
        if ((oldState?.current.directory ?? null) !== pending.expected) throw new Error('Installed plugin changed; inspect again')
        if (opts.feeds.some((i) => !parsed.feeds[i])) throw new Error('Invalid selected subscription')
        emit('plugins:progress', { id, phase: 'install' })
        const config = prepareConfig(parsed.manifest, opts.config, old)
        if (!old) newIdForCleanup = id
        const root = await owned(pluginCache(id))
        await mkdir(root, { recursive: true })
        target = await owned(join(root, `${parsed.hash}-${randomBytes(6).toString('hex')}`))
        await rename(pending.prepared.root, target)
        const installed = await parsePlugin(target, pending.options)
        if (installed.hash !== parsed.hash) throw new Error('Plugin changed during installation')
        await mkdir(await owned(pluginData(id)), { recursive: true })
        checkCanceled()
        reconnect = listServers()
          .filter((s) => s.pluginId === id && s.enabled && s.state === 'ready')
          .map((s) => ({ pluginId: id, directory: oldState!.current.directory, serverId: s.id }))
        await disconnectPlugin(id)
        checkCanceled()
        const version: InstalledVersion = {
          hash: parsed.hash,
          version: parsed.version,
          directory: target,
          options: pending.options,
          capabilities: parsed.capabilities
        }
        getDb().transaction(() => {
          const values = {
            market: pending.origin.market,
            version: parsed.version,
            previousVersion: old?.version ?? null,
            enabled: old?.enabled ?? true,
            capabilities: JSON.stringify(parsed.capabilities),
            config: config.config,
            secretsEnc: config.secretsEnc,
            updatedAt: Date.now()
          }
          getDb()
            .insert(plugins)
            .values({ ...values, id, installedAt: old?.installedAt ?? Date.now() })
            .onConflictDoUpdate({ target: plugins.id, set: values })
            .run()
          writeState(id, {
            origin: pending.origin,
            current: version,
            previous: oldState?.current,
            secretKeys: config.secretKeys,
            starterProgress: oldState?.starterProgress
          })
          writeMcp(id, installed)
          for (const index of new Set(opts.feeds)) {
            const f = installed.feeds[index]
            if (
              getDb()
                .select()
                .from(feeds)
                .where(eq(feeds.pluginId, id))
                .all()
                .some((r) => r.url === f.url && !r.deletedAt)
            )
              continue
            // 保存停用行避免事务失败后留下排队任务；提交后调度器按真实 enabled 状态抓取。
            const created = saveFeed({ ...f, enabled: false, goalId: null })
            getDb().update(feeds).set({ pluginId: id, enabled: true }).where(eq(feeds.id, created.id)).run()
          }
          record(old ? 'update' : 'install', id)
        })
        committed = true
        active.committed = true
        replacePluginRegistry(id, installed)
        notify()
        // 提交后清理失败不回报安装失败；重启会继续回收，仅操作插件自有目录。
        await cleanupVersions(id).catch(() => undefined)
        return getPlugin(id)
      } finally {
        installing.delete(token)
        if (!committed && active.canceled) recovery.push(...reconnect)
        if (!committed && target) await rm(target, { recursive: true, force: true })
        if (!committed && newIdForCleanup) {
          await rm(await owned(pluginData(newIdForCleanup)), { recursive: true, force: true })
          await rm(await owned(pluginCache(newIdForCleanup)), { recursive: true, force: true })
        }
        await pending.prepared.cleanup().catch(() => undefined)
      }
    })
  } finally {
    // 清理与互斥释放后再恢复；每次 await 后重查版本与许可，仍经过真正的 MCP 连接 guard。
    for (const candidate of recovery) {
      await (async () => {
        const plugin = getDb().select().from(plugins).where(eq(plugins.id, candidate.pluginId)).get()
        if (!plugin?.enabled || !registeredPlugin(candidate.pluginId)) return
        if (readState(candidate.pluginId).current.directory !== candidate.directory) return
        const server = listServers().find((s) => s.id === candidate.serverId)
        if (server?.pluginId !== candidate.pluginId || !server.enabled || server.state !== 'idle') return
        await connectServer(candidate.serverId)
      })().catch(() => undefined)
    }
  }
}
export function setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
  return pluginMutation(async () => {
    pluginRow(id)
    if (!registeredPlugin(id)) throw new Error('Plugin unavailable')
    if (!enabled) await disconnectPlugin(id)
    getDb().transaction(() => {
      getDb().update(plugins).set({ enabled, updatedAt: Date.now() }).where(eq(plugins.id, id)).run()
      if (!enabled) disablePluginMcpRows(id)
      record(enabled ? 'enable' : 'disable', id)
    })
    replacePluginRegistry(id, registeredPlugin(id))
    notify()
    return getPlugin(id)
  })
}
export function setPluginConfig(id: string, values: PluginConfig): Promise<PluginInfo> {
  return pluginMutation(async () => {
    const row = pluginRow(id),
      parsed = registeredPlugin(id)
    if (!parsed) throw new Error('Plugin unavailable')
    const next = prepareConfig(parsed.manifest, values, row)
    await disconnectPlugin(id)
    getDb().transaction(() => {
      getDb()
        .update(plugins)
        .set({ config: next.config, secretsEnc: next.secretsEnc, updatedAt: Date.now() })
        .where(eq(plugins.id, id))
        .run()
      writeState(id, { ...readState(id), secretKeys: next.secretKeys })
      disablePluginMcpRows(id)
      record('configure', id)
    })
    notify()
    return getPlugin(id)
  })
}
export function rollbackPlugin(id: string): Promise<PluginInfo> {
  return pluginMutation(async () => {
    const row = pluginRow(id),
      state = readState(id),
      previous = state.previous
    if (!previous) throw new Error('No previous plugin version')
    await owned(previous.directory)
    const parsed = await parsePlugin(previous.directory, previous.options)
    if (parsed.hash !== previous.hash) throw new Error('Previous plugin version changed')
    const config = prepareConfig(parsed.manifest, {}, row)
    await disconnectPlugin(id)
    getDb().transaction(() => {
      getDb()
        .update(plugins)
        .set({
          version: previous.version,
          previousVersion: state.current.version,
          capabilities: JSON.stringify(previous.capabilities),
          config: config.config,
          secretsEnc: config.secretsEnc,
          updatedAt: Date.now()
        })
        .where(eq(plugins.id, id))
        .run()
      writeState(id, { ...state, current: previous, previous: state.current, secretKeys: config.secretKeys })
      writeMcp(id, parsed)
      record('rollback', id)
    })
    replacePluginRegistry(id, parsed)
    notify()
    return getPlugin(id)
  })
}
interface RemovalJournal {
  id: string
  moves: { from: string; to: string }[]
}
/** 不完整或冲突的记录不代表用户数据可删除；移出恢复队列并原样保留供检查。 */
async function quarantineRemoval(trash: string): Promise<void> {
  try {
    const root = await owned(join(pluginRoot(), 'quarantine'))
    await mkdir(root, { recursive: true })
    await rename(trash, join(root, randomBytes(16).toString('hex')))
  } catch {
    // 隔离失败也保留原目录，不能阻断其余插件初始化或冒险清理。
  }
}
async function recoverRemoval(trash: string): Promise<void> {
  try {
    await owned(trash)
    const journalFile = await owned(join(trash, 'journal.json'))
    if ((await lstat(journalFile)).size > 16_384) throw new Error('Invalid plugin recovery journal')
    const value: unknown = JSON.parse(await readFile(journalFile, 'utf8'))
    if (!value || typeof value !== 'object') throw new Error('Invalid plugin recovery journal')
    const journal = value as RemovalJournal
    if (
      typeof journal.id !== 'string' ||
      !journal.id.includes('@') ||
      journal.id.length > 512 ||
      !Array.isArray(journal.moves) ||
      !journal.moves.length ||
      journal.moves.length > 2
    )
      throw new Error('Invalid plugin recovery journal')
    const sources = new Set<string>()
    const installed = !!getDb().select().from(plugins).where(eq(plugins.id, journal.id)).get()
    // 先验证整个记录和所有目录；不能恢复到一半才发现后续路径越界或数据冲突。
    for (const [i, move] of journal.moves.entries()) {
      if (
        !move ||
        ![pluginCache(journal.id), pluginData(journal.id)].includes(move.from) ||
        move.to !== join(trash, String(i)) ||
        sources.has(move.from)
      )
        throw new Error('Invalid plugin recovery journal')
      sources.add(move.from)
      await owned(move.from)
      await owned(move.to)
      const fromExists = existsSync(move.from),
        toExists = existsSync(move.to)
      if ((installed && fromExists === toExists) || (!installed && fromExists)) throw new Error('Ambiguous plugin recovery directories')
      for (const path of [move.from, move.to])
        if (existsSync(path) && !(await lstat(path)).isDirectory()) throw new Error('Invalid plugin recovery directory')
    }
    const allowed = new Set(['journal.json', ...journal.moves.map((_, i) => String(i))])
    if ((await readdir(trash)).some((name) => !allowed.has(name))) throw new Error('Unknown plugin recovery data')
    if (installed) for (const move of journal.moves) if (existsSync(move.to)) renameSync(move.to, move.from)
    await rm(trash, { recursive: true, force: true })
  } catch {
    await quarantineRemoval(trash)
  }
}
export function uninstallPlugin(id: string, options: { removeFeeds?: boolean; removeTasks?: boolean } = {}): Promise<void> {
  return pluginMutation(() => uninstallMany([id], options))
}
/** 市场移除与多个插件的 DB 删除共享一次事务；每个目录沿用已审查的恢复 journal。 */
export function uninstallPluginsForMarket(select: () => { ids: string[]; commit: () => void }): Promise<void> {
  return pluginMutation(async () => {
    const { ids, commit } = select()
    await uninstallMany(ids, {}, commit)
  })
}
async function uninstallMany(ids: string[], options: { removeFeeds?: boolean; removeTasks?: boolean }, commit?: () => void): Promise<void> {
  const staged: { id: string; trash: string; moves: { from: string; to: string }[] }[] = []
  const effects: (() => void)[] = []
  let failure: unknown
  const afterCommit = (effect: () => void): void => {
    effects.push(effect)
  }
  try {
    for (const id of ids) {
      pluginRow(id)
      const trash = await owned(join(pluginRoot(), 'trash', randomBytes(16).toString('hex')))
      await mkdir(await owned(join(pluginRoot(), 'trash')), { recursive: true })
      await mkdir(trash)
      const moves = [pluginCache(id), pluginData(id)].filter(existsSync).map((from, i) => ({ from, to: join(trash, String(i)) }))
      for (const move of moves) await owned(move.from)
      await writeFile(join(trash, 'journal.tmp'), JSON.stringify({ id, moves }), { flag: 'wx', mode: 0o600 })
      await rename(join(trash, 'journal.tmp'), join(trash, 'journal.json'))
      staged.push({ id, trash, moves })
      await disconnectPlugin(id)
    }
    for (const { moves } of staged) for (const move of moves) renameSync(move.from, move.to)
    getDb().transaction(() => {
      for (const id of ids) {
        if (options.removeFeeds)
          for (const row of getDb().select().from(feeds).where(eq(feeds.pluginId, id)).all())
            removeFeed(row.id, { clearCache: true, afterCommit })
        if (options.removeTasks)
          for (const row of getDb().select().from(aiTasks).where(eq(aiTasks.pluginId, id)).all()) removeTask(row.id, afterCommit)
        getDb().update(feeds).set({ pluginId: null }).where(eq(feeds.pluginId, id)).run()
        getDb().update(aiTasks).set({ pluginId: null }).where(eq(aiTasks.pluginId, id)).run()
        getDb().delete(mcpServers).where(eq(mcpServers.pluginId, id)).run()
        getDb().delete(plugins).where(eq(plugins.id, id)).run()
        getDb()
          .delete(meta)
          .where(eq(meta.key, stateKey(id)))
          .run()
        record('uninstall', id)
      }
      commit?.()
    })
    for (const effect of effects) effect()
    for (const id of ids) {
      replacePluginRegistry(id)
      for (const [token, pending] of previews)
        if (`${pending.parsed.manifest.name}@${pending.origin.market}` === id) await cancelPluginPreview(token).catch(() => undefined)
    }
    notify()
  } catch (error) {
    failure = error
  } finally {
    // 不因一个清理失败跳过其余恢复；任何不确定的数据留给启动恢复处理。
    const results = await Promise.allSettled(staged.map(({ trash }) => recoverRemoval(trash)))
    const cleanupFailure = results.find((r) => r.status === 'rejected')
    if (cleanupFailure?.status === 'rejected') failure ??= cleanupFailure.reason
  }
  if (failure) throw failure
}
/** README 仅返回禁 HTML 的 Markdown 数据，渲染端仍必须禁 raw HTML 并外部打开链接。 */
export async function pluginDetails(input: { id?: string; token?: string }): Promise<PluginDetails> {
  const pending = input.token ? previews.get(input.token) : undefined
  if (input.token && (!pending || pending.expiresAt <= Date.now())) throw new Error('Plugin preview expired')
  const parsed = pending?.parsed ?? (input.id ? registeredPlugin(input.id) : undefined)
  if (!parsed) throw new Error('Plugin details unavailable')
  let readme = ''
  try {
    readme = await readPluginText(parsed.root, 'README.md')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // 保留 Markdown 文本；HTML 字符转义后不能形成元素或脚本。
  readme = readme.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const origin = pending?.origin ?? (input.id ? readState(input.id).origin : undefined)
  // 删除或换源后仍从已确认的安装记录投影原始来源；不借新同名市场赋予旧插件身份。
  let sourceUrl: string | undefined
  if (origin?.kind === 'github') sourceUrl = origin.locator
  else if (origin?.kind === 'market') {
    const source = JSON.parse(origin.locator) as MarketSource
    if (source.kind !== 'folder') sourceUrl = sourceLink(source)
  }
  return {
    sourceUrl,
    icon: await pluginIcon(parsed.root),
    installed: input.id ? getPlugin(input.id) : undefined,
    readme,
    unsupported: parsed.unsupported,
    starters: parsed.starters,
    // 给人看的名称（按界面语言），不是内部 ID
    contents: {
      skills: parsed.skills.filter((x) => x.metadata.kind !== 'lens').map((x) => x.metadata.title || x.name),
      lenses: parsed.skills.filter((x) => x.metadata.kind === 'lens').map((x) => x.metadata.title || x.name),
      templates: parsed.templates.map((x) => tr(x.title.zh, x.title.en)),
      frameworks: parsed.frameworks.map((x) => tr(x.title.zh, x.title.en)),
      recipes: parsed.recipes.map((x) => tr(x.name.zh, x.name.en)),
      starters: parsed.starters.map((x) => tr(x.title.zh, x.title.en)),
      feeds: parsed.feeds.map((x) => x.title),
      mcp: Object.keys(parsed.mcpServers)
    }
  }
}
export async function openPluginFolder(id: string): Promise<void> {
  pluginRow(id)
  await shell.openPath(await owned(readState(id).current.directory))
}
/** 必须在 IPC/后台任务启动前调用。不可访问插件自有根以外；未完成的版本提交由 DB 指针决定。 */
export async function initializePlugins(): Promise<void> {
  await pluginMutation(async () => {
    await mkdir(pluginRoot(), { recursive: true })
    await owned(pluginRoot())
    const trashRoot = await owned(join(pluginRoot(), 'trash'))
    for (const child of await readdir(trashRoot).catch(() => [])) await recoverRemoval(join(trashRoot, child))
    for (const [token] of previews) await cancelPluginPreview(token)
    await rm(await owned(join(pluginRoot(), 'previews')), { recursive: true, force: true })
    const installedRows = getDb().select().from(plugins).all()
    for (const row of installedRows) {
      try {
        const state = readState(row.id)
        await owned(state.current.directory)
        const parsed = await parsePlugin(state.current.directory, state.current.options)
        if (parsed.hash !== state.current.hash) throw new Error('Installed plugin changed')
        replacePluginRegistry(row.id, parsed)
        await cleanupVersions(row.id)
      } catch {
        getDb().transaction(() => {
          getDb().update(plugins).set({ enabled: false }).where(eq(plugins.id, row.id)).run()
          disablePluginMcpRows(row.id)
        })
        replacePluginRegistry(row.id)
      }
    }
    for (const kind of ['cache', 'data']) {
      const root = await owned(join(pluginRoot(), kind)),
        keep = new Set(installedRows.map((r) => (kind === 'cache' ? pluginCache(r.id) : pluginData(r.id))))
      for (const child of await readdir(root).catch(() => [])) {
        const path = await owned(join(root, child))
        if (!keep.has(path) && (await lstat(path)).isDirectory()) await rm(path, { recursive: true, force: true })
      }
    }
  })
}
