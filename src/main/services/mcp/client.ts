import { app, net } from 'electron'
import { eq } from 'drizzle-orm'
import log from 'electron-log/main'
import { dynamicTool, jsonSchema, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ToolListChangedNotificationSchema, type Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { getDb } from '../../db'
import { mcpServers } from '../../db/schema'
import { newId } from '../../lib/ids'
import { tr } from '../../lib/messages'
import { exposedName, resultText } from '../../lib/mcpText'
import { emit } from '../../events'
import {
  allowedPolicies,
  effectivePolicy,
  levelFromAnnotations,
  type McpServerInfo,
  type McpServerInput,
  type McpServerState,
  type ToolPolicy
} from '@shared/agent'
import type { ToolMeta } from '../agent/wrap'
import { openJson, sealJson } from './secrets'
import { loginPath } from './shellPath'
import { registeredPlugin } from '../plugins/registry'
import { assertPluginDomain, assertPluginMcpReady, resolveInstalledMcp } from '../plugins/config'
import { pluginMutation, pluginOperationInProgress } from '../plugins/state'
import { clearOAuth, hasOAuth, JiweiOAuthProvider } from './oauth'

// 积微作为 MCP 客户端（v0.7）：接入外部 MCP 服务器（本地命令或远程地址），把它们的工具交给助手使用。
// 连接在第一次需要时建立并保持；每个工具按级别和用户策略（自动 / 每次询问 / 禁止）执行，结果一律作为外部数据。

type Row = typeof mcpServers.$inferSelect

interface Conn {
  client: Client
  transport: Transport
  tools: McpTool[]
}
const conns = new Map<string, Conn>()
const status = new Map<string, { state: McpServerState; error: string | null }>()
const connecting = new Map<string, Promise<void>>()
const epochs = new Map<string, number>()
const pendingTransports = new Map<string, { epoch: number; transport: Transport }>()

/** 工具多于这个数时，只给助手“找工具 / 调用工具”两个入口，避免工具描述占满上下文 */
/** 策略表里的 "*" 是服务器级默认（收费 / 数据出本机的插件装好时设为每次询问），单个工具的设置优先 */
const DIRECT_LIMIT = 24
const CONNECT_TIMEOUT_MS = 30_000

const changed = (): void => emit('mcp:changed', {})
const setStatus = (id: string, state: McpServerState, error: string | null = null): void => {
  status.set(id, { state, error })
  changed()
}

const rows = (): Row[] => getDb().select().from(mcpServers).all()
const row = (id: string): Row => {
  const r = getDb().select().from(mcpServers).where(eq(mcpServers.id, id)).get()
  if (!r) throw new Error(tr('找不到这个外部工具服务器', 'MCP server not found'))
  return r
}
const policies = (r: Row): Record<string, ToolPolicy> => JSON.parse(r.toolPolicies) as Record<string, ToolPolicy>

function toInfo(r: Row): McpServerInfo {
  const conn = conns.get(r.id)
  const st = status.get(r.id)
  const p = policies(r)
  return {
    id: r.id,
    pluginId: r.pluginId ?? undefined,
    name: r.name,
    transport: r.transport,
    command: r.command,
    args: JSON.parse(r.args) as string[],
    cwd: r.cwd,
    url: r.url,
    envKeys: r.pluginId
      ? Object.keys(registeredPlugin(r.pluginId)?.mcpServers[r.name]?.env ?? {})
      : Object.keys(openJson<Record<string, string>>(r.envEnc, {})),
    headerKeys: r.pluginId
      ? Object.keys(registeredPlugin(r.pluginId)?.mcpServers[r.name]?.headers ?? {})
      : Object.keys(openJson<Record<string, string>>(r.headersEnc, {})),
    oauth: r.pluginId ? !!r.oauthEnc : hasOAuth(r.id),
    enabled: r.enabled,
    state: !r.enabled ? 'off' : conn ? 'ready' : (st?.state ?? 'idle'),
    error: st?.error ?? null,
    tools: (conn?.tools ?? []).map((t) => {
      const level = levelFromAnnotations(t.annotations)
      return {
        name: t.name,
        title: t.title ?? t.annotations?.title ?? t.name,
        description: (t.description ?? '').slice(0, 400),
        level,
        policy: effectivePolicy(level, p[t.name] ?? p['*'])
      }
    })
  }
}

export function listServers(): McpServerInfo[] {
  return rows()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toInfo)
}

function mergeSecrets(old: Buffer | null, patch: Record<string, string> | undefined): Buffer | null {
  if (!patch) return old
  const next = { ...openJson<Record<string, string>>(old, {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (!k.trim()) continue
    if (v === '') delete next[k]
    else next[k] = v
  }
  return Object.keys(next).length ? sealJson(next) : null
}

export async function saveServer(input: McpServerInput): Promise<McpServerInfo> {
  const current = input.id ? row(input.id) : undefined
  if (current?.pluginId)
    return pluginMutation(async () => {
      // 插件服务器的执行声明只可由已确认的版本更新；普通 MCP 编辑器不能扩权。
      if (
        input.name !== current.name ||
        input.transport !== current.transport ||
        (input.command ?? null) !== current.command ||
        JSON.stringify(input.args ?? []) !== current.args ||
        (input.cwd ?? null) !== current.cwd ||
        (input.url ?? null) !== current.url ||
        input.env ||
        input.headers
      )
        throw new Error('Edit plugin configuration or inspect an updated plugin to change its MCP declaration')
      if (input.enabled) assertPluginMcpReady(current)
      if (input.enabled === false) await disconnect(current.id)
      getDb()
        .update(mcpServers)
        .set({ enabled: input.enabled ?? current.enabled, updatedAt: Date.now() })
        .where(eq(mcpServers.id, current.id))
        .run()
      changed()
      return toInfo(row(current.id))
    })
  const now = Date.now()
  const db = getDb()
  if (input.id) {
    const old = row(input.id)
    const reconnect =
      input.transport !== old.transport ||
      (input.command ?? null) !== old.command ||
      JSON.stringify(input.args ?? []) !== old.args ||
      (input.url ?? null) !== old.url ||
      !!input.env ||
      !!input.headers ||
      (input.cwd ?? null) !== old.cwd
    db.update(mcpServers)
      .set({
        name: input.name,
        transport: input.transport,
        command: input.transport === 'stdio' ? (input.command ?? null) : null,
        args: JSON.stringify(input.transport === 'stdio' ? (input.args ?? []) : []),
        cwd: input.cwd ?? null,
        url: input.transport === 'http' ? (input.url ?? null) : null,
        envEnc: mergeSecrets(old.envEnc, input.env),
        headersEnc: mergeSecrets(old.headersEnc, input.headers),
        ...(input.url !== undefined && input.url !== old.url ? { oauthEnc: null } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: now
      })
      .where(eq(mcpServers.id, input.id))
      .run()
    if (reconnect || input.enabled === false) await disconnect(input.id)
    changed()
    return toInfo(row(input.id))
  }
  const id = newId()
  db.insert(mcpServers)
    .values({
      id,
      name: input.name,
      transport: input.transport,
      command: input.transport === 'stdio' ? (input.command ?? null) : null,
      args: JSON.stringify(input.transport === 'stdio' ? (input.args ?? []) : []),
      cwd: input.cwd ?? null,
      url: input.transport === 'http' ? (input.url ?? null) : null,
      envEnc: mergeSecrets(null, input.env),
      headersEnc: mergeSecrets(null, input.headers),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now
    })
    .run()
  changed()
  return toInfo(row(id))
}

export async function removeServer(id: string): Promise<void> {
  if (row(id).pluginId) throw new Error('Remove this server by uninstalling its plugin')
  await disconnect(id)
  getDb().delete(mcpServers).where(eq(mcpServers.id, id)).run()
  status.delete(id)
  changed()
}

export function setToolPolicy(serverId: string, toolName: string, policy: ToolPolicy): McpServerInfo {
  const r = row(serverId)
  const t = conns.get(serverId)?.tools.find((x) => x.name === toolName)
  const level = levelFromAnnotations(t?.annotations)
  if (!allowedPolicies(level).includes(policy))
    throw new Error(tr('对外有影响的工具不能设为自动执行', 'Tools with external effects cannot run automatically'))
  const next = { ...policies(r), [toolName]: policy }
  getDb()
    .update(mcpServers)
    .set({ toolPolicies: JSON.stringify(next), updatedAt: Date.now() })
    .where(eq(mcpServers.id, serverId))
    .run()
  changed()
  return toInfo(row(serverId))
}

export async function logoutServer(id: string): Promise<McpServerInfo> {
  await disconnect(id)
  clearOAuth(id)
  changed()
  return toInfo(row(id))
}

/* ——— 连接 ——— */

async function makeTransport(r: Row, oauth: JiweiOAuthProvider): Promise<{ transport: Transport; stderr: () => string }> {
  const resolved = r.pluginId ? resolveInstalledMcp(r) : undefined
  if (r.transport === 'stdio') {
    const env = {
      ...getDefaultEnvironment(),
      PATH: await loginPath(),
      ...(resolved?.env ?? openJson<Record<string, string>>(r.envEnc, {}))
    }
    const transport = new StdioClientTransport({
      command: resolved?.command ?? r.command!,
      args: resolved?.args ?? (JSON.parse(r.args) as string[]),
      cwd: resolved?.cwd ?? r.cwd ?? app.getPath('home'),
      env,
      stderr: 'pipe'
    })
    let tail = ''
    transport.stderr?.on('data', (d: Buffer) => {
      if (!r.pluginId) tail = (tail + d.toString('utf8')).slice(-2000)
    })
    return { transport, stderr: () => tail.trim().split('\n').slice(-4).join('\n') }
  }
  const headers = resolved?.headers ?? openJson<Record<string, string>>(r.headersEnc, {})
  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
  const transport = new StreamableHTTPClientTransport(new URL(resolved?.url ?? r.url!), {
    requestInit: { headers },
    fetch: r.pluginId ? pluginFetch(r.pluginId) : (net.fetch as unknown as typeof fetch),
    ...(hasAuthHeader ? {} : { authProvider: oauth })
  })
  return { transport, stderr: () => '' }
}

/** SDK 的 OAuth discovery/token 请求也使用此 fetch；每跳重定向重新校验。 */
export function pluginFetch(pluginId: string): typeof fetch {
  return async (input, init) => {
    let request = new Request(input, init)
    for (let hop = 0; hop < 6; hop++) {
      assertPluginDomain(pluginId, request.url)
      const response = await net.fetch(request.clone(), { redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      if (!location) return response
      const target = new URL(location, request.url)
      assertPluginDomain(pluginId, target.toString())
      // 改 host 的时候不转发调用凭据。静态 confirmed domain 列表不能授权跨域泄露。
      if (target.origin !== new URL(request.url).origin) throw new Error('Cross-origin plugin MCP redirect rejected')
      const method = response.status === 303 || ([301, 302].includes(response.status) && request.method === 'POST') ? 'GET' : request.method
      request = new Request(target, {
        method,
        headers: request.headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : await request.clone().arrayBuffer(),
        signal: request.signal
      })
    }
    throw new Error('Plugin MCP redirect limit exceeded')
  }
}

function friendly(e: unknown, r: Row, stderr: string): string {
  if (r.pluginId)
    return tr('插件连接失败，请检查配置与已确认的能力', 'Plugin connection failed; check configuration and confirmed capabilities')
  const msg = e instanceof Error ? e.message : String(e)
  if (/ENOENT|not found|spawn/i.test(msg) && r.transport === 'stdio')
    return tr(
      `找不到命令「${r.command}」。请确认已安装，或填写完整路径。`,
      `Command “${r.command}” not found. Install it or use a full path.`
    )
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg))
    return tr('连不上这个地址，请检查网址和网络。', 'Could not reach this address. Check the URL and network.')
  if (/401|403|Unauthorized/i.test(msg))
    return tr('服务器拒绝访问：请检查令牌，或重新登录。', 'Access denied: check the token or sign in again.')
  return stderr ? `${msg}\n${stderr}` : msg
}

async function attach(id: string, r: Row, made: { transport: Transport; stderr: () => string }): Promise<Conn> {
  const { transport, stderr } = made
  const client = new Client({ name: 'jiwei', version: app.getVersion() }, { capabilities: {} })
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e
    await transport.close().catch(() => undefined)
    // eslint-disable-next-line preserve-caught-error -- SDK errors may contain substituted plugin credentials.
    throw new Error(friendly(e, r, stderr()))
  }
  const tools: McpTool[] = []
  try {
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor && tools.length < 500)
  } catch (e) {
    await client.close().catch(() => undefined)
    throw e
  }
  const conn: Conn = { client, transport, tools }
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    try {
      conn.tools = (await client.listTools()).tools
      changed()
    } catch (e) {
      log.warn('[mcp] refresh tools failed', r.pluginId ? 'Plugin MCP refresh failed' : e)
    }
  })
  transport.onclose = () => {
    if (conns.get(id) === conn) {
      conns.delete(id)
      setStatus(id, 'idle')
    }
  }
  return conn
}

/**
 * 连接一个服务器。interactive：允许打开浏览器登录并等待（设置页里点“连接”时）；
 * 助手使用时不等待登录，需要登录的服务器先跳过。
 */
export function connectServer(
  id: string,
  opts: { interactive?: boolean; openBrowser?: (url: URL) => Promise<void> | void } = {}
): Promise<void> {
  const current = row(id)
  if (!current.enabled) return Promise.reject(new Error('This server is disabled'))
  if (current.pluginId) {
    if (pluginOperationInProgress()) return Promise.reject(new Error('Plugin operation in progress'))
    assertPluginMcpReady(current)
  }
  if (conns.has(id)) return Promise.resolve()
  const running = connecting.get(id)
  if (running) return running
  const epoch = epochs.get(id) ?? 0
  const valid = (): boolean =>
    (epochs.get(id) ?? 0) === epoch && !!getDb().select().from(mcpServers).where(eq(mcpServers.id, id)).get()?.enabled
  const job = (async () => {
    const r = row(id)
    if (!r.enabled) throw new Error(tr('这个服务器已停用', 'This server is disabled'))
    setStatus(id, 'connecting')
    const oauth = new JiweiOAuthProvider(
      id,
      opts.openBrowser,
      r.pluginId
        ? (url) => {
            if (!valid()) throw new Error('Connection canceled')
            assertPluginDomain(r.pluginId!, url.toString())
          }
        : undefined
    )
    try {
      let conn: Conn
      const made = await makeTransport(r, oauth)
      if (!valid()) {
        await made.transport.close().catch(() => undefined)
        throw new Error('Connection canceled')
      }
      pendingTransports.set(id, { epoch, transport: made.transport })
      try {
        conn = await attach(id, r, made)
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) throw e
        if (!opts.interactive) {
          setStatus(
            id,
            'auth',
            tr('需要登录：在「连接」设置里点“连接”完成授权。', 'Sign-in required: connect it in Settings → Connections.')
          )
          throw new Error(tr('需要登录', 'Sign-in required'), { cause: e })
        }
        setStatus(id, 'auth', tr('请在浏览器中完成登录……', 'Finish signing in in your browser…'))
        const code = await oauth.waitForCode()
        if (!valid()) {
          await made.transport.close().catch(() => undefined)
          // eslint-disable-next-line preserve-caught-error -- The authorization error can include credentials.
          throw new Error('Connection canceled')
        }
        await (made.transport as StreamableHTTPClientTransport).finishAuth(code)
        await made.transport.close().catch(() => undefined)
        const refreshed = await makeTransport(r, oauth)
        if (!valid()) {
          await refreshed.transport.close().catch(() => undefined)
          // eslint-disable-next-line preserve-caught-error -- Do not propagate the original OAuth credential-bearing error.
          throw new Error('Connection canceled')
        }
        pendingTransports.set(id, { epoch, transport: refreshed.transport })
        conn = await attach(id, r, refreshed)
      }
      if (!valid()) {
        await conn.client.close().catch(() => undefined)
        throw new Error('Connection canceled')
      }
      conns.set(id, conn)
      setStatus(id, 'ready')
    } catch (e) {
      const st = status.get(id)
      const error = r.pluginId ? new Error('Plugin connection failed; check configuration and confirmed capabilities') : e
      if (valid() && (st?.state !== 'auth' || opts.interactive))
        setStatus(id, 'error', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      const pending = pendingTransports.get(id)
      if (pending?.epoch === epoch) {
        pendingTransports.delete(id)
        if (!conns.has(id)) await pending.transport.close().catch(() => undefined)
      }
      if ((epochs.get(id) ?? 0) === epoch) connecting.delete(id)
    }
  })()
  connecting.set(id, job)
  return job
}

export async function testServer(id: string): Promise<McpServerInfo> {
  await disconnect(id)
  try {
    await connectServer(id, { interactive: true })
  } catch {
    // 错误已记在状态里，界面显示
  }
  return toInfo(row(id))
}

export async function disconnect(id: string): Promise<void> {
  epochs.set(id, (epochs.get(id) ?? 0) + 1)
  connecting.delete(id)
  const pending = pendingTransports.get(id)
  pendingTransports.delete(id)
  if (pending) await pending.transport.close().catch(() => undefined)
  const c = conns.get(id)
  conns.delete(id)
  if (c) await c.client.close().catch(() => undefined)
  status.set(id, { state: 'idle', error: null })
}

export async function closeAllMcp(): Promise<void> {
  await Promise.all([...new Set([...conns.keys(), ...connecting.keys()])].map((id) => disconnect(id)))
}

/* ——— 给助手的工具 ——— */

async function callTool(
  serverId: string,
  name: string,
  args: Record<string, unknown>,
  zh: boolean,
  signal?: AbortSignal,
  readOnly = false
): Promise<string> {
  await connectServer(serverId)
  const conn = conns.get(serverId)!
  if (readOnly) {
    const current = row(serverId),
      tool = conn.tools.find((t) => t.name === name)
    if (
      !current.enabled ||
      !tool ||
      levelFromAnnotations(tool.annotations) !== 'read' ||
      effectivePolicy('read', policies(current)[name] ?? policies(current)['*']) !== 'auto'
    )
      throw new Error(tr('工具权限已改变，后台调用已跳过', 'Tool permissions changed; background call skipped'))
  }
  // 在调用前保留来源，停用/卸载并发也不能让 SDK 的含密文错误越过 guard/audit 边界。
  const pluginOrigin = !!row(serverId).pluginId
  try {
    const r = await conn.client.callTool({ name, arguments: args }, undefined, { timeout: 110_000, signal })
    const text = resultText(r as never, zh)
    if (r.isError) throw new Error(text)
    return text
  } catch (error) {
    if (!pluginOrigin) throw error
    // eslint-disable-next-line preserve-caught-error -- 插件 SDK 错误可能包含注入的凭证，不能通过 cause 泄漏。
    throw new Error(
      zh ? '插件工具调用失败，请检查插件配置和服务状态' : 'Plugin tool call failed; check plugin configuration and server status'
    )
  }
}

/** 参数给用户看：每行“名称：值”，不显示原始 JSON */
function argsText(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 200))
    .slice(0, 8)
    .join('\n')
}

interface Entry {
  serverId: string
  server: string
  tool: McpTool
  exposed: string
  meta: ToolMeta
}

export async function assistantMcpTools(
  zh: boolean,
  options: { readOnly?: boolean; direct?: boolean } = {}
): Promise<{ tools: ToolSet; meta: Record<string, ToolMeta> }> {
  const enabled = rows().filter((r) => r.enabled)
  if (!enabled.length) return { tools: {}, meta: {} }
  await Promise.all(
    enabled.map((r) =>
      conns.has(r.id) || status.get(r.id)?.state === 'auth'
        ? null
        : Promise.race([connectServer(r.id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12_000))]).catch((e) =>
            log.warn('[mcp] skip', r.name, e instanceof Error ? e.message : e)
          )
    )
  )
  const entries: Entry[] = []
  for (const r of enabled) {
    const conn = conns.get(r.id)
    if (!conn) continue
    const p = policies(r)
    for (const t of conn.tools) {
      const level = levelFromAnnotations(t.annotations)
      if (options.readOnly && level !== 'read') continue
      const policy = effectivePolicy(level, p[t.name] ?? p['*'])
      if (policy === 'deny') continue
      const title = t.title ?? t.annotations?.title ?? t.name
      entries.push({
        serverId: r.id,
        server: r.name,
        tool: t,
        exposed: exposedName(r.name, r.id, t.name),
        meta: {
          level,
          policy,
          server: r.name,
          untrusted: true,
          ...(options.readOnly
            ? {
                dynamic: () => {
                  const current = rows().find((x) => x.id === r.id),
                    currentTool = conns.get(r.id)?.tools.find((x) => x.name === t.name)
                  const level = currentTool ? levelFromAnnotations(currentTool.annotations) : 'external'
                  return {
                    level,
                    untrusted: true,
                    server: r.name,
                    policy:
                      current?.enabled && currentTool ? effectivePolicy(level, policies(current)[t.name] ?? policies(current)['*']) : 'deny'
                  }
                }
              }
            : {}),
          describe: (input) => ({
            title: zh ? `使用「${r.name}」的工具：${title}` : `Use “${title}” from ${r.name}`,
            detail: argsText(input)
          })
        }
      })
    }
  }
  const tools: ToolSet = {}
  const meta: Record<string, ToolMeta> = {}
  if (options.direct || entries.length <= DIRECT_LIMIT) {
    for (const e of entries) {
      tools[e.exposed] = dynamicTool({
        description: `[${e.server}] ${(e.tool.description ?? e.tool.name).slice(0, 1000)}`,
        inputSchema: jsonSchema(e.tool.inputSchema as never),
        execute: (input, opts) =>
          callTool(e.serverId, e.tool.name, (input ?? {}) as Record<string, unknown>, zh, opts.abortSignal, options.readOnly)
      })
      meta[e.exposed] = e.meta
    }
    return { tools, meta }
  }
  // 工具很多：先找再用（借鉴 monid 的 discover / inspect / run）
  const byName = new Map(entries.map((e) => [e.exposed, e]))
  tools.mcp_find_tools = tool({
    description: zh
      ? `在已接入的外部工具（${[...new Set(entries.map((e) => e.server))].join('、')}，共 ${entries.length} 个）中按关键词查找，返回工具名、说明和参数格式。之后用 mcp_call 调用。`
      : `Search the connected external tools (${entries.length}) by keyword; returns names, descriptions and input schemas. Then use mcp_call.`,
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    execute: async ({ query }) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      const scored = entries
        .map((e) => {
          const hay = `${e.server} ${e.tool.name} ${e.tool.title ?? ''} ${e.tool.description ?? ''}`.toLowerCase()
          return { e, score: words.filter((w) => hay.includes(w)).length }
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
      if (!scored.length) return zh ? '没有找到相关的外部工具。' : 'No matching tools.'
      return scored
        .map(
          ({ e }) =>
            `${e.exposed}\n[${e.server}] ${(e.tool.description ?? '').slice(0, 300)}\n${JSON.stringify(e.tool.inputSchema).slice(0, 1200)}`
        )
        .join('\n\n')
    }
  })
  meta.mcp_find_tools = { level: 'read' }
  tools.mcp_call = tool({
    description: zh ? '调用 mcp_find_tools 找到的外部工具。tool 为工具名，arguments 为参数对象。' : 'Call a tool found by mcp_find_tools.',
    inputSchema: z.object({ tool: z.string().max(80), arguments: z.record(z.string(), z.unknown()).optional() }),
    execute: async ({ tool: name, arguments: args }, opts) => {
      const e = byName.get(name)
      if (!e) throw new Error(zh ? '没有这个工具，请先用 mcp_find_tools 查找。' : 'Unknown tool; use mcp_find_tools first.')
      return callTool(e.serverId, e.tool.name, args ?? {}, zh, opts.abortSignal)
    }
  })
  meta.mcp_call = {
    level: 'external',
    dynamic: (input) => byName.get(String(input.tool ?? ''))?.meta ?? { level: 'external', policy: 'ask', untrusted: true }
  }
  return { tools, meta }
}
