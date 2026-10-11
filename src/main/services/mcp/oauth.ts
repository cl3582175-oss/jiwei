import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { app, shell } from 'electron'
import { eq } from 'drizzle-orm'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getDb } from '../../db'
import { mcpServers } from '../../db/schema'
import { tr } from '../../lib/messages'
import { openJson, sealJson } from './secrets'

// 远程 MCP 服务器的 OAuth 2.1 登录（动态注册 + PKCE，按 MCP 规范由官方 SDK 完成协议部分）。
// 积微负责：保存客户端信息与令牌（钥匙串加密）、在系统浏览器里打开登录页、在 127.0.0.1 上接收回调。

export const OAUTH_CALLBACK_PORT = Number(process.env.JIWEI_OAUTH_PORT) || 38518
const CALLBACK_PATH = '/oauth/callback'
const WAIT_MS = 5 * 60_000

interface Stored {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  verifier?: string
}

function load(serverId: string): Stored {
  const row = getDb().select({ oauthEnc: mcpServers.oauthEnc }).from(mcpServers).where(eq(mcpServers.id, serverId)).get()
  return openJson<Stored>(row?.oauthEnc, {})
}
function save(serverId: string, patch: Partial<Stored>): void {
  const next = { ...load(serverId), ...patch }
  getDb()
    .update(mcpServers)
    .set({ oauthEnc: sealJson(next) })
    .where(eq(mcpServers.id, serverId))
    .run()
}
export function clearOAuth(serverId: string): void {
  getDb().update(mcpServers).set({ oauthEnc: null }).where(eq(mcpServers.id, serverId)).run()
}
export const hasOAuth = (serverId: string): boolean => !!load(serverId).tokens

/* ——— 回调接收 ——— */

const waiters = new Map<string, { resolve: (code: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
let server: Server | null = null

const page = (ok: boolean, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>积微</title><body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#1f2a2b;background:#f6f4ef"><div style="text-align:center"><div style="font-size:40px">${ok ? '✓' : '!'}</div><p>${text}</p></div></body>`

function ensureCallbackServer(): Promise<void> {
  if (server?.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`)
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end()
        return
      }
      const state = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code')
      const w = waiters.get(state)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (!w) {
        res.end(page(false, tr('这次登录已过期，请回到积微重新连接。', 'This sign-in has expired. Return to Jiwei and connect again.')))
        return
      }
      waiters.delete(state)
      clearTimeout(w.timer)
      if (code) {
        res.end(page(true, tr('已完成授权，可以回到积微了。', 'Authorized. You can return to Jiwei.')))
        w.resolve(code)
      } else {
        const err = url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'denied'
        res.end(page(false, tr(`授权没有完成：${err}`, `Authorization failed: ${err}`)))
        w.reject(new Error(tr(`授权没有完成：${err}`, `Authorization failed: ${err}`)))
      }
      if (!waiters.size) setTimeout(() => stopCallbackServer(), 1000)
    })
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(
        new Error(
          e.code === 'EADDRINUSE'
            ? tr(`登录回调端口 ${OAUTH_CALLBACK_PORT} 被占用，请关闭占用它的程序后重试`, `Callback port ${OAUTH_CALLBACK_PORT} is in use`)
            : e.message
        )
      )
    )
    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => resolve())
  })
}

export function stopCallbackServer(): void {
  server?.close()
  server = null
}

/** 在系统浏览器里打开登录页。开发构建的端到端测试可改为直接请求（测试服务器自动同意并跳回回调地址） */
async function openAuthorization(url: URL): Promise<void> {
  if (!app.isPackaged && process.env.JIWEI_TEST_OAUTH_FOLLOW === '1') {
    void fetch(url).catch(() => undefined)
    return
  }
  await shell.openExternal(url.toString())
}

/* ——— 提供给 SDK 的 OAuth 客户端 ——— */

export class JiweiOAuthProvider implements OAuthClientProvider {
  private pendingState = ''
  private codePromise: Promise<string> | null = null
  /** 浏览器登录页已打开（等待用户完成） */
  opened = false

  constructor(
    private serverId: string,
    /** 测试时不打开系统浏览器，而是交给调用方 */
    private open: (url: URL) => Promise<void> | void = openAuthorization
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${CALLBACK_PATH}`
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: tr('积微', 'Jiwei'),
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }
  state(): string {
    this.pendingState = randomBytes(16).toString('hex')
    return this.pendingState
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return load(this.serverId).client
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    save(this.serverId, { client: info })
  }
  tokens(): OAuthTokens | undefined {
    return load(this.serverId).tokens
  }
  saveTokens(tokens: OAuthTokens): void {
    save(this.serverId, { tokens })
  }
  saveCodeVerifier(verifier: string): void {
    save(this.serverId, { verifier })
  }
  codeVerifier(): string {
    const v = load(this.serverId).verifier
    if (!v) throw new Error('No code verifier')
    return v
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const s = load(this.serverId)
    if (scope === 'all') clearOAuth(this.serverId)
    else if (scope === 'client') save(this.serverId, { ...s, client: undefined })
    else if (scope === 'tokens') save(this.serverId, { ...s, tokens: undefined })
    else if (scope === 'verifier') save(this.serverId, { ...s, verifier: undefined })
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    await ensureCallbackServer()
    const state = url.searchParams.get('state') ?? this.pendingState
    this.codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(state)
        reject(new Error(tr('等待浏览器登录超时', 'Timed out waiting for browser sign-in')))
      }, WAIT_MS)
      waiters.set(state, { resolve, reject, timer })
    })
    this.opened = true
    await this.open(url)
  }
  /** SDK 抛出 UnauthorizedError 之后：等浏览器回调带回授权码 */
  waitForCode(): Promise<string> {
    if (!this.codePromise)
      return Promise.reject(new Error(tr('服务器要求登录，但没有给出登录地址', 'The server requires sign-in but gave no URL')))
    return this.codePromise
  }
}
