import { canonicalItemUrl } from '../../../lib/feedParser'

const TRACKING_PARAMS = new Set([
  'spm',
  'from',
  'share',
  'share_source',
  'share_medium',
  'fbclid',
  'gclid',
  'ref',
  'ref_src',
  'source',
  'timestamp',
  '_t'
])

export function canonicalUrl(value: string): string | null {
  const canonical = canonicalItemUrl(value)
  if (!canonical) return null
  const url = new URL(canonical)
  url.hostname = url.hostname.toLowerCase()
  for (const name of new Set(url.searchParams.keys()))
    if (name.startsWith('utm_') || TRACKING_PARAMS.has(name)) url.searchParams.delete(name)
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.searchParams.sort()
  return url.href
}

/** 仅用于去重比较；保存地址仍使用 canonicalUrl，保留原协议与 www。 */
export function urlKey(value: string): string | null {
  const canonical = canonicalUrl(value)
  if (!canonical) return null
  const url = new URL(canonical)
  url.hostname = url.hostname.replace(/^www\./, '')
  url.protocol = 'https:'
  return url.href
}
