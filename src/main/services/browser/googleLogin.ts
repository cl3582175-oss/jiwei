// 借系统 Chrome 登录 Google（设计见 docs/specs/browser-google-login-via-chrome.md）。
// Google 不允许在嵌入式浏览器里输入账号；这里用一个独立临时配置目录拉起真 Chrome，
// 用户在里面登录，积微只读取 Google / YouTube 的 cookie 写入内置浏览器会话，随后关闭 Chrome 并删除临时目录。
// 账号密码从不经过积微；cookie 只在内存里处理，不落盘、不写日志。
import { app, session } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
import { createServer } from 'net'
import { join } from 'path'
import log from 'electron-log/main'
import { tr } from '../../lib/messages'
import { emit } from '../../events'
import type { GoogleLoginInfo, GoogleLoginState } from '@shared/types'
import {
  chromeArgs,
  findChrome,
  hasGoogleSession,
  isGoogleCookieDomain,
  toElectronCookie,
  type ChromeCookie
} from '../../lib/googleLoginCore'
import { PARTITION, afterGoogleLogin } from './manager'

const TIMEOUT_MS = 10 * 60_000
const POLL_MS = 2000

let state: GoogleLoginState = { status: 'idle' }
let run: { cancel: (reason: NonNullable<GoogleLoginState['reason']>) => void } | null = null

function setState(next: GoogleLoginState): void {
  state = next
  emit('browser:google-login', state)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

/** 开发构建可指定浏览器路径，供端到端测试替身使用 */
function chromePath(): string | null {
  const forced = !app.isPackaged ? process.env.JIWEI_TEST_CHROME_PATH : undefined
  if (forced) return forced
  return findChrome({ platform: process.platform, exists: existsSync, env: process.env })
}

async function devtoolsUrl(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? null
  } catch {
    return null
  }
}

/** 通过 DevTools 协议读取浏览器全部 cookie。每次读取新建连接，读完即断开。 */
async function readCookies(wsUrl: string): Promise<ChromeCookie[]> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('devtools'))
  })
  try {
    return await new Promise<ChromeCookie[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('devtools timeout')), 5000)
      ws.onmessage = (m) => {
        const d = JSON.parse(String(m.data)) as { id?: number; result?: { cookies: ChromeCookie[] } }
        if (d.id !== 1) return
        clearTimeout(timer)
        resolve(d.result?.cookies ?? [])
      }
      ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }))
    })
  } finally {
    ws.close()
  }
}

async function removeDir(dir: string): Promise<void> {
  // Chrome 退出后目录可能短暂被占用，重试几次
  for (let i = 0; i < 6; i++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(500)
    }
  }
  log.warn('[google-login] 临时目录未能删除')
}

async function stopChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(4000)])
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
}

export const googleLoginInfo = async (): Promise<GoogleLoginInfo> => {
  const cookies = await session.fromPartition(PARTITION).cookies.get({ domain: 'google.com' })
  return { loggedIn: hasGoogleSession(cookies.map((c) => ({ name: c.name, domain: c.domain ?? '' }))), state }
}

export function cancelGoogleLogin(): void {
  run?.cancel('cancelled')
}

export function startGoogleLogin(): void {
  if (run) return
  const exe = chromePath()
  if (!exe) {
    setState({
      status: 'failed',
      reason: 'no-chrome',
      message: tr(
        '没有找到 Google Chrome 或 Microsoft Edge。请先安装其中一个，再重试。',
        'Google Chrome or Microsoft Edge was not found. Install one and try again.'
      )
    })
    return
  }
  let finished: NonNullable<GoogleLoginState['reason']> | null = null
  run = { cancel: (reason) => void (finished ??= reason) }
  setState({ status: 'waiting' })
  void (async () => {
    const profile = join(app.getPath('userData'), `google-login-${Date.now().toString(36)}`)
    let child: ChildProcess | null = null
    try {
      await mkdir(profile, { recursive: true })
      const port = await freePort()
      child = spawn(exe, chromeArgs(profile, port), { stdio: 'ignore' })
      child.once('exit', () => (finished ??= 'closed'))
      child.once('error', () => (finished ??= 'error'))
      const started = Date.now()
      let wsUrl: string | null = null
      let cookies: ChromeCookie[] | null = null
      while (!finished && Date.now() - started < TIMEOUT_MS) {
        wsUrl ??= await devtoolsUrl(port)
        if (wsUrl) {
          const list = await readCookies(wsUrl).catch(() => null)
          if (list && hasGoogleSession(list)) {
            // 等 Chrome 把登录后的 cookie 写完整
            await sleep(2500)
            cookies = await readCookies(wsUrl).catch(() => list)
            break
          }
        }
        await sleep(POLL_MS)
      }
      if (!cookies) {
        setState({ status: 'failed', ...failure(finished ?? 'timeout') })
        return
      }
      setState({ status: 'injecting' })
      const ses = session.fromPartition(PARTITION)
      for (const c of cookies) {
        const e = toElectronCookie(c)
        if (e) await ses.cookies.set(e).catch(() => {})
      }
      await ses.cookies.flushStore()
      afterGoogleLogin()
      setState({ status: 'done' })
    } catch (e) {
      log.warn('[google-login]', e instanceof Error ? e.message : 'failed')
      setState({ status: 'failed', ...failure('error') })
    } finally {
      run = null
      if (child) await stopChrome(child)
      await removeDir(profile)
    }
  })()
}

function failure(reason: NonNullable<GoogleLoginState['reason']>): Pick<GoogleLoginState, 'reason' | 'message'> {
  const message =
    reason === 'cancelled'
      ? tr('已取消登录。', 'Sign-in cancelled.')
      : reason === 'timeout'
        ? tr('等待登录超时，已关闭 Chrome 窗口。', 'Timed out waiting for sign-in. The Chrome window was closed.')
        : reason === 'closed'
          ? tr('Chrome 窗口在登录完成前被关闭了。', 'The Chrome window was closed before sign-in finished.')
          : tr('登录没有完成。请重试。', 'Sign-in did not finish. Please try again.')
  return { reason, message }
}

/** 退出积微浏览器中的 Google 登录（只清 Google / YouTube 的 cookie） */
export async function googleLogout(): Promise<void> {
  const ses = session.fromPartition(PARTITION)
  const all = await ses.cookies.get({})
  for (const c of all) {
    if (!c.domain || !isGoogleCookieDomain(c.domain)) continue
    const host = c.domain.replace(/^\./, '')
    await ses.cookies.remove(`https://${host}${c.path ?? '/'}`, c.name).catch(() => {})
  }
  await ses.cookies.flushStore()
  setState({ status: 'idle' })
  afterGoogleLogin()
}
