import { app } from 'electron'
import { isIP } from 'node:net'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { sources } from '../../db/schema'
import { isSensitiveUrl } from '../../lib/browserPolicy'
import { tr } from '../../lib/messages'
import { getSettings } from '../settings'
import { urlKey } from './backends/normalize'

export class PagePolicyError extends Error {
  constructor(readonly reason: 'invalid' | 'private' | 'sensitive' | 'excluded' | 'serp') {
    const messages = {
      invalid: ['网址无效', 'Invalid address'],
      private: ['暂不支持读取本地或私有网络地址', 'Local or private network addresses cannot be read'],
      sensitive: ['该网站已设置为不给 AI', 'This website is excluded from AI'],
      excluded: ['该资料已设置为不给 AI', 'This source is excluded from AI'],
      serp: ['不使用内置浏览器读取搜索结果页', 'Search engine result pages cannot be read by the background browser']
    } as const
    const message = messages[reason]
    super(tr(message[0], message[1]))
    this.name = 'PagePolicyError'
  }
}
/** DNS主机的末尾点不改变目的地；仅在读取策略内规范化，避免隐私规则被等价拼写绕过。 */
function policyKey(value: string): string | null {
  try {
    const url = new URL(value)
    url.hostname = url.hostname.replace(/\.+$/, '')
    return urlKey(url.href)
  } catch {
    return null
  }
}
/** 只查URL与排除标记，不读取正文、片段或素材；每次重查以立即响应隐私变化。 */
export function isExcludedSourceUrl(value: string): boolean {
  const key = policyKey(value)
  if (!key) return false
  return getDb()
    .select({ url: sources.url })
    .from(sources)
    .where(eq(sources.aiExcluded, true))
    .all()
    .some((row) => row.url !== null && policyKey(row.url) === key)
}
function privateHost(hostname: string): boolean {
  const host = hostname.replace(/\.+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  // 公网IPv6仅允许全局单播2000::/3；映射IPv4、ULA、链路本地和多播都拒绝。
  if (isIP(host) === 6) return !/^[23]/.test(host) || host.startsWith('2001:db8:')
  return !host.includes('.') || /(?:^|\.)(localhost|local|internal|lan|home)$/.test(host)
}
function serp(url: URL): boolean {
  const host = url.hostname.toLowerCase(),
    path = url.pathname.replace(/\/+$/, '') || '/'
  const query = url.searchParams
  if (/^(?:www\.|m\.|encrypted\.)?google\.[a-z.]+$/.test(host))
    return path === '/search' || ((path === '/' || path === '/webhp') && query.has('q'))
  if (/^(?:www\.|m\.|wap\.)?baidu\.com$/.test(host)) return path === '/s' || path.endsWith('/s')
  if (/(^|\.)bing\.com$/.test(host)) return path === '/search' || (path === '/' && query.has('q'))
  if (/(^|\.)duckduckgo\.com$/.test(host)) return query.has('q') || path === '/html' || path === '/lite'
  if (host === 'search.yahoo.com') return path === '/search'
  if (host === 'search.brave.com') return path === '/search' || (path === '/' && query.has('q'))
  if (/^(?:www\.|m\.)?sogou\.com$/.test(host)) return path === '/web'
  if (/^(?:www\.|m\.)?so\.com$/.test(host)) return path === '/s'
  if (/^(?:www\.)?yandex\.[a-z.]+$/.test(host)) return path === '/search'
  return false
}
export function assertReadableUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error()
  } catch {
    throw new PagePolicyError('invalid')
  }
  const fixture = !app.isPackaged && process.env.JIWEI_TEST_NETWORK === '1' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const hostname = url.hostname.replace(/\.+$/, '')
  if (!hostname) throw new PagePolicyError('invalid')
  url.hostname = hostname
  if (!fixture && privateHost(url.hostname)) throw new PagePolicyError('private')
  const blocked = (getSettings().browser?.aiBlockedSites ?? []).map((host) => host.trim().replace(/\.+$/, ''))
  if (isSensitiveUrl(url.href, blocked)) throw new PagePolicyError('sensitive')
  if (serp(url)) throw new PagePolicyError('serp')
  if (isExcludedSourceUrl(url.href)) throw new PagePolicyError('excluded')
}
