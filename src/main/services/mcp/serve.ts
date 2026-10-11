import { app } from 'electron'
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createServer as createNetServer, connect, type Server as NetServer, type Socket } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import log from 'electron-log/main'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getDb } from '../../db'
import { mcpClients } from '../../db/schema'
import { newId } from '../../lib/ids'
import { tr } from '../../lib/messages'
import { emit } from '../../events'
import { DEFAULT_MCP_PORT, type McpAccess, type McpClientInfo, type McpClientSecret, type McpServeStatus } from '@shared/agent'
import { getSettings } from '../settings'
import { createServeServer, type ServeClient } from './serverTools'

// 积微作为 MCP 服务端的传输层（v0.7）：
//   - Streamable HTTP：只监听 127.0.0.1，Bearer 令牌，检查 Host / Origin 防 DNS 重绑定；无状态（每个请求一个服务实例）。
//   - stdio：客户端启动零依赖的桥接脚本（用积微自带的 Node），脚本把标准输入输出转发到本机套接字，第一行发令牌。
// 每个客户端一个令牌，库里只存 SHA-256；默认关闭，在设置「连接」里打开。

type ClientRow = typeof mcpClients.$inferSelect

let http: HttpServer | null = null
let sock: NetServer | null = null
let httpError: string | null = null
let listeningPort = 0
const sockets = new Set<Socket>()

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')
const newToken = (): string => `jw_${randomBytes(32).toString('base64url')}`
const changed = (): void => emit('mcp:changed', {})

const toInfo = (r: ClientRow): McpClientInfo => ({
  id: r.id,
  name: r.name,
  access: r.access,
  enabled: r.enabled,
  lastUsedAt: r.lastUsedAt,
  createdAt: r.createdAt
})

/* ——— 路径 ——— */

const mcpDir = (): string => join(app.getPath('userData'), 'mcp')
export const bridgePath = (): string => join(mcpDir(), 'jiwei-mcp.cjs')

export function socketPath(): string {
  const id = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 10)
  if (process.platform === 'win32') return `\\\\.\\pipe\\jiwei-mcp-${id}`
  const preferred = join(mcpDir(), 'jiwei.sock')
  // Unix 套接字路径有长度上限（macOS 104 字节）
  return Buffer.byteLength(preferred) <= 100 ? preferred : join(tmpdir(), `jiwei-mcp-${id}.sock`)
}

/** 桥接脚本：零依赖，Claude Desktop、Cursor 等客户端启动它，它把标准输入输出接到正在运行的积微 */
const BRIDGE = `#!/usr/bin/env node
// 积微 MCP 桥接（自动生成，请勿修改）：把标准输入输出转发到正在运行的积微。
'use strict'
const net = require('net')
const path = process.env.JIWEI_MCP_SOCKET
const token = process.env.JIWEI_MCP_TOKEN
const fail = (msg) => { process.stderr.write('[jiwei] ' + msg + '\\n'); process.exit(1) }
if (!path || !token) fail('JIWEI_MCP_SOCKET and JIWEI_MCP_TOKEN are required')
const c = net.connect(path)
c.on('error', (e) => fail('Jiwei is not running, or "Let other apps use Jiwei" is off (' + e.code + ')'))
c.write('JIWEI-MCP 1 ' + token + '\\n')
let buf = Buffer.alloc(0)
const onData = (d) => {
  buf = Buffer.concat([buf, d])
  const i = buf.indexOf(10)
  if (i < 0) { if (buf.length > 4096) fail('bad handshake'); return }
  const line = buf.subarray(0, i).toString('utf8')
  const rest = buf.subarray(i + 1)
  c.removeListener('data', onData)
  if (line !== 'OK') fail(line.replace(/^ERR /, ''))
  if (rest.length) process.stdout.write(rest)
  c.pipe(process.stdout)
  process.stdin.pipe(c)
}
c.on('data', onData)
c.on('close', () => process.exit(0))
process.stdin.on('end', () => c.end())
`

function writeBridge(): void {
  mkdirSync(mcpDir(), { recursive: true })
  writeFileSync(bridgePath(), BRIDGE, { mode: 0o755 })
}

/* ——— 客户端与令牌 ——— */

function authenticate(token: string | undefined): ServeClient | null {
  if (!token) return null
  const h = Buffer.from(hash(token))
  const r = getDb()
    .select()
    .from(mcpClients)
    .all()
    .find((c) => c.enabled && timingSafeEqual(Buffer.from(c.tokenHash), h))
  if (!r) return null
  getDb().update(mcpClients).set({ lastUsedAt: Date.now() }).where(eq(mcpClients.id, r.id)).run()
  return { id: r.id, name: r.name, access: r.access }
}

export function listClients(): McpClientInfo[] {
  return getDb().select().from(mcpClients).orderBy(desc(mcpClients.createdAt)).all().map(toInfo)
}

function secretFor(r: ClientRow, token: string): McpClientSecret {
  const node = process.execPath
  const stdio = {
    command: node,
    args: [bridgePath()],
    env: { ELECTRON_RUN_AS_NODE: '1', JIWEI_MCP_SOCKET: socketPath(), JIWEI_MCP_TOKEN: token }
  }
  const port = getSettings().mcpServe?.port ?? DEFAULT_MCP_PORT
  const url = `http://127.0.0.1:${port}/mcp`
  return {
    client: toInfo(r),
    token,
    configs: [
      { id: 'claude-desktop', label: 'Claude Desktop', text: JSON.stringify({ mcpServers: { jiwei: stdio } }, null, 2) },
      { id: 'cursor', label: 'Cursor', text: JSON.stringify({ mcpServers: { jiwei: { type: 'stdio', ...stdio } } }, null, 2) },
      { id: 'claude-code', label: 'Claude Code', text: `claude mcp add-json jiwei '${JSON.stringify({ type: 'stdio', ...stdio })}'` },
      {
        id: 'http',
        label: tr('HTTP 地址', 'HTTP'),
        text: JSON.stringify({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } }, null, 2)
      }
    ]
  }
}

export function createClient(name: string, access: McpAccess): McpClientSecret {
  const token = newToken()
  const row: ClientRow = { id: newId(), name, tokenHash: hash(token), access, enabled: true, lastUsedAt: null, createdAt: Date.now() }
  getDb().insert(mcpClients).values(row).run()
  writeBridge()
  changed()
  return secretFor(row, token)
}

export function updateClient(id: string, patch: { name?: string; access?: McpAccess; enabled?: boolean }): McpClientInfo {
  getDb().update(mcpClients).set(patch).where(eq(mcpClients.id, id)).run()
  changed()
  return toInfo(getDb().select().from(mcpClients).where(eq(mcpClients.id, id)).get()!)
}

export function rotateToken(id: string): McpClientSecret {
  const token = newToken()
  getDb()
    .update(mcpClients)
    .set({ tokenHash: hash(token) })
    .where(eq(mcpClients.id, id))
    .run()
  writeBridge()
  changed()
  return secretFor(getDb().select().from(mcpClients).where(eq(mcpClients.id, id)).get()!, token)
}

export function removeClient(id: string): void {
  getDb().delete(mcpClients).where(eq(mcpClients.id, id)).run()
  changed()
}

/* ——— HTTP ——— */

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

function reject(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 8 * 1024 * 1024) throw new Error('Request too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/mcp') return reject(res, 404, 'Not found')
  // 防 DNS 重绑定：浏览器里的恶意网页不能借用户的本机访问积微
  if (!LOCAL_HOST.test(req.headers.host ?? '')) return reject(res, 403, 'Forbidden host')
  const origin = req.headers.origin
  if (origin && !LOCAL_ORIGIN.test(origin)) return reject(res, 403, 'Forbidden origin')
  const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim()
  const client = authenticate(auth)
  if (!client) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="jiwei"')
    return reject(res, 401, 'Invalid or missing token. Create a client in Jiwei → Settings → Connections.')
  }
  if (req.method !== 'POST') return reject(res, 405, 'Method not allowed (stateless server: use POST)')
  let body: unknown
  try {
    body = await readBody(req)
  } catch (e) {
    return reject(res, 400, e instanceof Error ? e.message : 'Bad request')
  }
  const server = createServeServer(client)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

/* ——— 本机套接字（stdio 桥接） ——— */

function handleSocket(socket: Socket): void {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => undefined)
  let buf = Buffer.alloc(0)
  const timer = setTimeout(() => socket.destroy(), 10_000)
  const onData = (d: Buffer): void => {
    buf = Buffer.concat([buf, d])
    const i = buf.indexOf(10)
    if (i < 0) {
      if (buf.length > 4096) socket.destroy()
      return
    }
    clearTimeout(timer)
    socket.removeListener('data', onData)
    const line = buf.subarray(0, i).toString('utf8')
    const rest = buf.subarray(i + 1)
    const m = /^JIWEI-MCP 1 (\S+)$/.exec(line)
    const client = m ? authenticate(m[1]) : null
    if (!client) {
      socket.end(
        `ERR ${tr('令牌无效或客户端已停用，请在积微「设置 → 连接」里重新复制配置。', 'Invalid token or disabled client. Copy the config again from Jiwei → Settings → Connections.')}\n`
      )
      return
    }
    socket.write('OK\n')
    socket.pause()
    if (rest.length) socket.unshift(rest)
    const server = createServeServer(client)
    const transport = new StdioServerTransport(socket, socket)
    socket.on('close', () => void server.close())
    // 显式 pause 过的流，加 data 监听不会自动恢复：连接后手动 resume
    void server
      .connect(transport)
      .then(() => socket.resume())
      .catch((e) => {
        log.warn('[mcp-serve] socket connect failed', e)
        socket.destroy()
      })
  }
  socket.on('data', onData)
}

async function clearStaleSocket(path: string): Promise<void> {
  if (process.platform === 'win32' || !existsSync(path)) return
  const alive = await new Promise<boolean>((resolve) => {
    const c = connect(path)
    c.once('connect', () => {
      c.destroy()
      resolve(true)
    })
    c.once('error', () => resolve(false))
  })
  if (alive) throw new Error(tr('另一个积微正在提供 MCP 服务', 'Another Jiwei instance is serving MCP'))
  unlinkSync(path)
}

/* ——— 启停 ——— */

export async function startServe(): Promise<void> {
  await stopServe()
  const s = getSettings().mcpServe
  if (!s?.enabled) {
    changed()
    return
  }
  writeBridge()
  const port = s.port || DEFAULT_MCP_PORT
  httpError = null
  await new Promise<void>((resolve) => {
    const server = createHttpServer((req, res) => {
      handleHttp(req, res).catch((e) => {
        log.warn('[mcp-serve] http failed', e)
        if (!res.headersSent) reject(res, 500, 'Internal error')
      })
    })
    server.once('error', (e: NodeJS.ErrnoException) => {
      httpError = e.code === 'EADDRINUSE' ? tr(`端口 ${port} 已被占用，请换一个端口`, `Port ${port} is already in use`) : e.message
      log.warn('[mcp-serve] http listen failed', e.message)
      resolve()
    })
    server.listen(port, '127.0.0.1', () => {
      http = server
      listeningPort = port
      resolve()
    })
  })
  try {
    const path = socketPath()
    await clearStaleSocket(path)
    await new Promise<void>((resolve, rejectListen) => {
      const server = createNetServer(handleSocket)
      server.once('error', rejectListen)
      server.listen(path, () => {
        sock = server
        resolve()
      })
    })
  } catch (e) {
    log.warn('[mcp-serve] socket listen failed', e)
    httpError = httpError ?? (e instanceof Error ? e.message : String(e))
  }
  changed()
}

export async function stopServe(): Promise<void> {
  for (const s of sockets) s.destroy()
  sockets.clear()
  const closing = Promise.all([
    new Promise<void>((r) => (http ? http.close(() => r()) : r())),
    new Promise<void>((r) => (sock ? sock.close(() => r()) : r()))
  ])
  http?.closeAllConnections()
  await closing
  http = null
  sock = null
  listeningPort = 0
}

export function serveStatus(): McpServeStatus {
  const s = getSettings().mcpServe ?? { enabled: false, port: DEFAULT_MCP_PORT }
  return {
    enabled: s.enabled,
    port: s.port,
    listening: !!http,
    error: s.enabled ? httpError : null,
    url: `http://127.0.0.1:${listeningPort || s.port}/mcp`,
    socket: socketPath(),
    bridge: bridgePath(),
    node: process.execPath
  }
}
