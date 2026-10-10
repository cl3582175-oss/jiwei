import { z } from 'zod'
export const DomainSchema = z
  .string()
  .toLowerCase()
  .trim()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
export const NetworkRuleSchema = z.object({ domain: DomainSchema, mode: z.enum(['direct', 'proxy']) })
export type NetworkRule = z.infer<typeof NetworkRuleSchema>
export const domainMatches = (host: string, domain: string): boolean => host === domain || host.endsWith('.' + domain)
export function websiteDomain(url: string): string {
  const host = new URL(url).hostname.toLowerCase(),
    parts = host.split('.')
  if (/^[\d.]+$/.test(host) || host === 'localhost') return host
  const count = /\.(?:com|co|org|net)\.(?:cn|uk|au|jp|nz|hk)$/.test(host) ? 3 : 2
  return parts.slice(-count).join('.')
}
export function loginBlocked(url: string, title = '', body = '', testHosts: string[] = []): 'google' | 'youtube' | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const google = u.hostname === 'accounts.google.com' || testHosts.includes(u.hostname)
  if (
    google &&
    (/^\/(?:signin|ServiceLogin|v3\/signin)/.test(u.pathname) ||
      /此浏览器或应用可能不安全|This browser or app may not be secure/i.test(title + '\n' + body))
  )
    return 'google'
  if (
    (domainMatches(u.hostname, 'youtube.com') || testHosts.includes(u.hostname)) &&
    /Sign in to confirm you['’]re not a bot|登录以确认你不是机器人/i.test(body)
  )
    return 'youtube'
  return null
}
export function generatePac(rules: NetworkRule[], systemProxy: string): string {
  if (
    !/^(?:DIRECT|(?:PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5) [\w.[\]:-]+)(?:;\s*(?:DIRECT|(?:PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5) [\w.[\]:-]+))*$/.test(
      systemProxy
    )
  )
    throw new Error('无法读取系统代理地址')
  const parsed = z
    .array(NetworkRuleSchema)
    .max(500)
    .parse(rules)
    .sort((a, b) => b.domain.length - a.domain.length)
  return `function FindProxyForURL(url, host) { host = host.toLowerCase();\n${parsed.map((r) => `if (host === ${JSON.stringify(r.domain)} || dnsDomainIs(host, ${JSON.stringify('.' + r.domain)})) return ${JSON.stringify(r.mode === 'direct' ? 'DIRECT' : systemProxy)};`).join('\n')}\nreturn ${JSON.stringify(systemProxy)};\n}`
}
