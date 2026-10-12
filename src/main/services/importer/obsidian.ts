export interface MatchEntry {
  path: string
  title: string
  aliases: string[]
}
import { posix } from 'path'
export function matchNote<T extends MatchEntry>(target: string, from: string, entries: T[], wiki = true): T | null {
  try {
    target = decodeURIComponent(target)
  } catch {
    return null
  }
  target = target.normalize('NFC').replace(/\\/g, '/').replace(/#.*$/, '')
  if (!target || target.startsWith('/') || /^[a-z]:/i.test(target)) return null
  const noExt = (p: string): string => p.replace(/\.(md|markdown|txt|csv)$/i, '').normalize('NFC')
  const local = posix.normalize(posix.join(posix.dirname(from), target))
  if (local.startsWith('../')) return null
  const unique = (items: T[]): T | null => (items.length === 1 ? items[0] : null)
  const at = unique(entries.filter((e) => noExt(e.path) === noExt(local)))
  if (at || !wiki) return at
  const exact = unique(entries.filter((e) => noExt(e.path) === noExt(target)))
  if (exact) return exact
  const suffix = entries.filter((e) => noExt(e.path).endsWith(`/${noExt(target)}`) || noExt(e.path) === noExt(target))
  if (suffix.length) return unique(suffix)
  return unique(entries.filter((e) => e.title === target || e.aliases.includes(target)))
}
