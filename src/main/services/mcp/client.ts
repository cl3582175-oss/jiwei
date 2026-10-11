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

/** 工具多于这个数时，只给助手“找工具 / 调用工具”两个入口，避免工具描述占满上下文 */
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
    name: r.name,
    transport: r.transport,
    command: r.command,
    args: JSON.parse(r.args) as string[],
    cwd: r.cwd,
    url: r.url,
    envKeys: Object.keys(openJson<Record<string, string>>(r.envEnc, {})),
    headerKeys: Object.keys(openJson<Record<string, string>>(r.headersEnc, {})),
    oauth: hasOAuth(r.id),
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
        policy: effectivePolicy(level, p[t.name])
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
  if (r.transport === 'stdio') {
    const env = { ...getDefaultEnvironment(), PATH: await loginPath(), ...openJson<Record<string, string>>(r.envEnc, {}) }
    const transport = new StdioClientTransport({
      command: r.command!,
      args: JSON.parse(r.args) as string[],
      cwd: r.cwd || app.getPath('home'),
      env,
      stderr: 'pipe'
    })
    let tail = ''
    transport.stderr?.on('data', (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-2000)
    })
    return { transport, stderr: () => tail.trim().split('\n').slice(-4).join('\n') }
  }
  const headers = openJson<Record<string, string>>(r.headersEnc, {})
  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
  const transport = new StreamableHTTPClientTransport(new URL(r.url!), {
    requestInit: { headers },
    fetch: net.fetch as unknown as typeof fetch,
    ...(hasAuthHeader ? {} : { authProvider: oauth })
  })
  return { transport, stderr: () => '' }
}

function friendly(e: unknown, r: Row, stderr: string): string {
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
    throw new Error(friendly(e, r, stderr()), { cause: e })
  }
  const tools: McpTool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor && tools.length < 500)
  const conn: Conn = { client, transport, tools }
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    try {
      conn.tools = (await client.listTools()).tools
      changed()
    } catch (e) {
      log.warn('[mcp] refresh tools failed', e)
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
  if (conns.has(id)) return Promise.resolve()
  const running = connecting.get(id)
  if (running) return running
  const job = (async () => {
    const r = row(id)
    if (!r.enabled) throw new Error(tr('这个服务器已停用', 'This server is disabled'))
    setStatus(id, 'connecting')
    const oauth = new JiweiOAuthProvider(id, opts.openBrowser)
    try {
      let conn: Conn
      const made = await makeTransport(r, oauth)
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
        await (made.transport as StreamableHTTPClientTransport).finishAuth(code)
        await made.transport.close().catch(() => undefined)
        conn = await attach(id, r, await makeTransport(r, oauth))
      }
      conns.set(id, conn)
      setStatus(id, 'ready')
    } catch (e) {
      const st = status.get(id)
      if (st?.state !== 'auth' || opts.interactive) setStatus(id, 'error', e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      connecting.delete(id)
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
  const c = conns.get(id)
  conns.delete(id)
  if (c) await c.client.close().catch(() => undefined)
  if (status.get(id)?.state === 'ready') status.set(id, { state: 'idle', error: null })
}

export async function closeAllMcp(): Promise<void> {
  await Promise.all([...conns.keys()].map((id) => disconnect(id)))
}

/* ——— 给助手的工具 ——— */

async function callTool(serverId: string, name: string, args: Record<string, unknown>, zh: boolean, signal?: AbortSignal): Promise<string> {
  await connectServer(serverId)
  const conn = conns.get(serverId)!
  const r = await conn.client.callTool({ name, arguments: args }, undefined, { timeout: 110_000, signal })
  const text = resultText(r as never, zh)
  if (r.isError) throw new Error(text)
  return text
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

export async function assistantMcpTools(zh: boolean): Promise<{ tools: ToolSet; meta: Record<string, ToolMeta> }> {
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
      const policy = effectivePolicy(level, p[t.name])
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
  if (entries.length <= DIRECT_LIMIT) {
    for (const e of entries) {
      tools[e.exposed] = dynamicTool({
        description: `[${e.server}] ${(e.tool.description ?? e.tool.name).slice(0, 1000)}`,
        inputSchema: jsonSchema(e.tool.inputSchema as never),
        execute: (input, opts) => callTool(e.serverId, e.tool.name, (input ?? {}) as Record<string, unknown>, zh, opts.abortSignal)
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
