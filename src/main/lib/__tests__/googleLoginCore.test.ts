import { describe, expect, it } from 'vitest'
import { chromeArgs, findChrome, hasGoogleSession, isGoogleCookieDomain, toElectronCookie, type ChromeCookie } from '../googleLoginCore'

const cookie = (over: Partial<ChromeCookie> = {}): ChromeCookie => ({
  name: 'SID',
  value: 'v',
  domain: '.google.com',
  path: '/',
  expires: 1900000000,
  secure: true,
  httpOnly: true,
  sameSite: 'None',
  ...over
})

describe('Google 登录 cookie 搬运', () => {
  it('只认 Google 与 YouTube 域名', () => {
    expect(isGoogleCookieDomain('.google.com')).toBe(true)
    expect(isGoogleCookieDomain('accounts.google.com')).toBe(true)
    expect(isGoogleCookieDomain('.youtube.com')).toBe(true)
    expect(isGoogleCookieDomain('.notgoogle.com')).toBe(false)
    expect(isGoogleCookieDomain('google.com.evil.example')).toBe(false)
    expect(isGoogleCookieDomain('.github.com')).toBe(false)
  })

  it('用账号会话 cookie 判断登录完成', () => {
    expect(hasGoogleSession([cookie({ name: 'NID' })])).toBe(false)
    expect(hasGoogleSession([cookie({ name: 'SID' })])).toBe(true)
    expect(hasGoogleSession([cookie({ name: '__Secure-1PSID' })])).toBe(true)
    expect(hasGoogleSession([cookie({ name: 'SID', domain: '.example.com' })])).toBe(false)
  })

  it('转换字段', () => {
    expect(toElectronCookie(cookie())).toEqual({
      url: 'https://google.com/',
      name: 'SID',
      value: 'v',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: 1900000000,
      sameSite: 'no_restriction'
    })
    expect(toElectronCookie(cookie({ domain: 'accounts.google.com', path: '/x', sameSite: 'Lax' }))).toMatchObject({
      url: 'https://accounts.google.com/x',
      domain: undefined,
      sameSite: 'lax'
    })
    expect(toElectronCookie(cookie({ sameSite: 'Strict' }))?.sameSite).toBe('strict')
    expect(toElectronCookie(cookie({ sameSite: undefined }))?.sameSite).toBe('unspecified')
  })

  it('带前缀的 cookie 强制 secure；会话 cookie 给有限期限', () => {
    const c = toElectronCookie(cookie({ name: '__Host-GAPS', secure: false, expires: -1 }), 1_000_000_000_000)
    expect(c?.secure).toBe(true)
    expect(c?.expirationDate).toBe(1_000_000_000 + 14 * 86400)
  })

  it('其他网站与分区 cookie 不搬运', () => {
    expect(toElectronCookie(cookie({ domain: '.example.com' }))).toBeNull()
    expect(toElectronCookie(cookie({ partitionKey: { topLevelSite: 'https://a.com' } }))).toBeNull()
  })
})

describe('找到可用的 Chrome', () => {
  const find = (platform: NodeJS.Platform, present: string[], env: Record<string, string> = {}) =>
    findChrome({ platform, exists: (p) => present.includes(p), env })

  it('mac：Chrome 优先，其次 Edge', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    expect(find('darwin', [edge, chrome])).toBe(chrome)
    expect(find('darwin', [edge])).toBe(edge)
    expect(find('darwin', [])).toBeNull()
  })

  it('Windows 与 Linux', () => {
    const env = { PROGRAMFILES: 'C:/Program Files' }
    const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    expect(find('win32', [chrome], env)).toBe(chrome)
    expect(find('linux', ['/usr/bin/chromium'])).toBe('/usr/bin/chromium')
  })

  it('调试端口只绑定本机并使用独立配置目录', () => {
    const args = chromeArgs('/tmp/p', 9333)
    expect(args).toContain('--user-data-dir=/tmp/p')
    expect(args).toContain('--remote-debugging-port=9333')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })
})
