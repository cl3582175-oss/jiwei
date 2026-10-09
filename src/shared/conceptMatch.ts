export interface ConceptMatch {
  name: string
  start: number
  end: number
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
const word = (s: string): boolean => !!s && /[\p{L}\p{N}\p{M}_]/u.test(s) && !/\p{Script=Han}/u.test(s)

/** 中文没有空格边界；拉丁词与标识符则不能命中另一个单词内部。偏移保留 UTF-16，供 DOM Range 使用。 */
export function findConceptMatches(text: string, names: readonly string[], limit = 500): ConceptMatch[] {
  if (!text || limit <= 0 || !Number.isFinite(limit)) return []
  const seen = new Set<string>()
  const ordered = names
    .map((name) => name.trim())
    .filter((name) => {
      const key = name.toLowerCase().replace(/\s+/g, ' ')
      if (!name || name.length > 40 || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 50)
    .sort((a, b) => b.length - a.length)
  const matches: ConceptMatch[] = []
  for (const name of ordered) {
    const characters = [...name]
    const firstIsHan = /\p{Script=Han}/u.test(characters[0])
    const lastIsHan = /\p{Script=Han}/u.test(characters.at(-1)!)
    const pattern = new RegExp(escape(name), 'giu')
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      const end = start + match[0].length
      const before = [...text.slice(Math.max(0, start - 2), start)].at(-1) ?? ''
      const after = [...text.slice(end, end + 2)][0] ?? ''
      if ((!firstIsHan && word(before)) || (!lastIsHan && word(after))) continue
      // 先占用长概念，避免“机器学习”同时被拆成“机器”和“学习”两个提示。
      if (matches.some((m) => m.start < end && start < m.end)) continue
      matches.push({ name, start, end })
      if (matches.length >= limit) return matches.sort((a, b) => a.start - b.start)
    }
  }
  return matches.sort((a, b) => a.start - b.start)
}
