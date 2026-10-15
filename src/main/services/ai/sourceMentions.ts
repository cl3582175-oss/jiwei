import type { ChatScope } from '@shared/schemas'
import { getSqlite } from '../../db'
import { onMainEvent } from '../../events'
import { normalizeExtracted, normalizeQuery } from '../../lib/textNormalize'

type Title = { sourceId: string; text: string; grams: Set<string> }
let cache: Title[] | null = null
let watching = false
const grams = (text: string): Set<string> => {
  const chars = [...text],
    out = new Set<string>()
  for (let i = 2; i < chars.length; i++) out.add(chars.slice(i - 2, i + 1).join(''))
  return out
}
function titleText(title: string): string {
  return normalizeExtracted(title.replace(/\.[a-z][a-z\d]{0,7}$/i, ''))
    .replace(/(?:19|20)\d{2}[.\-/_年]\d{1,2}[.\-/_月]\d{1,2}日?/g, '')
    .replace(/(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
function longest(a: string, b: string): string {
  const x = [...a],
    y = [...b]
  let previous = new Uint16Array(y.length + 1),
    best = 0,
    end = 0
  for (let i = 1; i <= x.length; i++) {
    const next = new Uint16Array(y.length + 1)
    for (let j = 1; j <= y.length; j++)
      if (x[i - 1] === y[j - 1]) {
        next[j] = previous[j - 1] + 1
        if (next[j] > best) {
          best = next[j]
          end = i
        }
      }
    previous = next
  }
  return x.slice(end - best, end).join('')
}
/** 只从可见资料库标题定位；即使所属对话持有allow，附件标题也永远不参与。 */
export function matchSourcesByTitle(query: string, scope: ChatScope): { sourceId: string; score: number; matched: string }[] {
  if (scope.type === 'none') return []
  const q = normalizeQuery(query),
    qgrams = grams(q)
  if (!qgrams.size) return []
  if (!watching) {
    onMainEvent('sources:changed', () => {
      cache = null
    })
    watching = true
  }
  cache ??= (
    getSqlite().prepare("SELECT id,title FROM sources WHERE deleted_at IS NULL AND ai_excluded=0 AND space='library'").all() as {
      id: string
      title: string
    }[]
  ).map((r) => {
    const text = titleText(r.title)
    return { sourceId: r.id, text, grams: grams(text) }
  })
  const titles = scope.type === 'items' ? cache.filter((t) => scope.sources.includes(t.sourceId)) : cache
  const candidates = titles
    .map((t) => ({ t, overlap: [...qgrams].filter((g) => t.grams.has(g)).length }))
    .filter((t) => t.overlap)
    .sort((a, b) => b.overlap - a.overlap || a.t.sourceId.localeCompare(b.t.sourceId))
    .slice(0, 30)
  return candidates
    .flatMap(({ t }) => {
      const matched = longest(q, t.text),
        length = [...matched].length
      if (length < 3 || (!/\p{Script=Han}/u.test(matched) && !/\d/.test(matched))) return []
      const df = titles.filter((other) => other.text.includes(matched)).length
      const score = length / (1 + Math.log(df))
      return df <= 3 && score >= 2.5 ? [{ sourceId: t.sourceId, score, matched }] : []
    })
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
    .slice(0, 5)
}
