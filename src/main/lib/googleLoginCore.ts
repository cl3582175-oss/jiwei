// 借系统 Chrome 登录 Google 的纯逻辑（不依赖 Electron，便于单元测试）。
// 设计见 docs/specs/browser-google-login-via-chrome.md。
import { join } from 'path'

export interface ChromeCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  partitionKey?: unknown
}

export interface ElectronCookie {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate: number
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** 只搬运 Google 与 YouTube 的 cookie；其他网站的登录不碰 */
const GOOGLE_DOMAINS = ['google.com', 'youtube.com']
export const isGoogleCookieDomain = (domain: string): boolean => {
  const d = domain.replace(/^\./, '').toLowerCase()
  return GOOGLE_DOMAINS.some((g) => d === g || d.endsWith('.' + g))
}

/** 登录完成的标志：账号会话 cookie 出现 */
export const hasGoogleSession = (cookies: Pick<ChromeCookie, 'name' | 'domain'>[]): boolean =>
  cookies.some((c) => (c.name === 'SID' || c.name === '__Secure-1PSID') && isGoogleCookieDomain(c.domain))

const SESSION_COOKIE_DAYS = 14

export function toElectronCookie(c: ChromeCookie, now = Date.now()): ElectronCookie | null {
  if (!isGoogleCookieDomain(c.domain) || c.partitionKey) return null
  const host = c.domain.replace(/^\./, '')
  const sameSite = c.sameSite?.toLowerCase()
  return {
    url: `https://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith('.') ? c.domain : undefined,
    path: c.path || '/',
    // __Secure- / __Host- 前缀必须带 secure
    secure: c.secure || /^__(Secure|Host)-/.test(c.name),
    httpOnly: c.httpOnly,
    // 会话 cookie 不跨重启保留，给一个有限期限，登录状态才不会在退出积微后丢失
    expirationDate: c.expires > 0 ? c.expires : Math.floor(now / 1000) + SESSION_COOKIE_DAYS * 86400,
    sameSite: sameSite === 'none' ? 'no_restriction' : sameSite === 'lax' ? 'lax' : sameSite === 'strict' ? 'strict' : 'unspecified'
  }
}

export interface ChromeEnv {
  platform: NodeJS.Platform
  exists: (path: string) => boolean
  env: Record<string, string | undefined>
}

/** 按 Chrome → Edge → Chromium 的顺序找到可用的浏览器；找不到返回 null */
export function findChrome({ platform, exists, env }: ChromeEnv): string | null {
  const candidates: string[] = []
  if (platform === 'darwin') {
    for (const base of ['/Applications', join(env.HOME ?? '', 'Applications')])
      candidates.push(
        join(base, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
        join(base, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        join(base, 'Chromium.app/Contents/MacOS/Chromium')
      )
  } else if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter((x): x is string => !!x)
    for (const r of roots) candidates.push(join(r, 'Google/Chrome/Application/chrome.exe'))
    for (const r of roots) candidates.push(join(r, 'Microsoft/Edge/Application/msedge.exe'))
  } else {
    for (const dir of ['/usr/bin', '/usr/local/bin', '/opt/google/chrome', '/snap/bin'])
      candidates.push(
        join(dir, 'google-chrome'),
        join(dir, 'google-chrome-stable'),
        join(dir, 'microsoft-edge'),
        join(dir, 'chromium'),
        join(dir, 'chromium-browser')
      )
  }
  return candidates.find((p) => exists(p)) ?? null
}

export function chromeArgs(profileDir: string, port: number, startUrl = 'https://accounts.google.com/'): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    startUrl
  ]
}
