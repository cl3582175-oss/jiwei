import { DomainSchema } from '@shared/browserSafety'

/** 只保存主机名，避免路径、协议或大小写让用户的可信度规则悄悄失效。 */
export function normalizeSiteLines(text: string): { sites: string[]; dropped: number } {
  const sites = new Set<string>()
  let dropped = 0
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    try {
      if (/\s/.test(value)) throw new Error()
      const url = new URL(value.includes('://') ? value : 'https://' + value)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error()
      const host = url.hostname.toLowerCase().replace(/\.$/, '')
      const parsed = DomainSchema.safeParse(host)
      if (!parsed.success || host.length > 200) throw new Error()
      sites.add(parsed.data)
    } catch {
      dropped++
    }
  }
  return { sites: [...sites], dropped }
}

/** 与主进程的实例校验保持一致；这里仅提供即时反馈，保存时仍由 IPC 再校验。 */
export function normalizeSearxngAddress(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase()
    const octets = host.split('.').map(Number)
    const privateIp =
      octets.length === 4 &&
      octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168))
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.local') || privateIp
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol === 'http:' && !local)
    )
      return null
    const normalized = url.href.replace(/\/+$/, '')
    return normalized.length <= 500 ? normalized : null
  } catch {
    return null
  }
}
