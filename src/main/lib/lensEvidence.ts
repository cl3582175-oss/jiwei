import type { EvidenceSentence, LensDrop, LensItem } from '@shared/lens'

export const EVIDENCE_MIN_OVERLAP = 0.15
export const EVIDENCE_VECTOR_MIN = 0.45
const clean = (s: string): string =>
  s
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
const bigrams = (s: string): Set<string> => {
  const chars = [...clean(s)]
  return new Set(chars.slice(0, -1).map((c, i) => c + chars[i + 1]))
}
/** 以条目自身为分母；长证据不能掩盖条目中的大量编造文字。 */
export function bigramOverlap(body: string, evidence: string): number {
  const a = bigrams(body),
    b = bigrams(evidence)
  if (!a.size) return clean(body).length > 0 && clean(evidence).includes(clean(body)) ? 1 : 0
  return [...a].filter((x) => b.has(x)).length / a.size
}
/** 子串编辑距离允许证据前后有别的话，但引语自身最多改写 10%。 */
export function nearVerbatim(quote: string, evidence: string): boolean {
  const a = [...clean(quote)],
    b = [...clean(evidence)]
  if (!a.length || !b.length) return false
  if (b.join('').includes(a.join(''))) return true
  let previous = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return Math.min(...previous) / a.length <= 0.1
}
export async function validateEvidence(
  items: LensItem[],
  sentences: EvidenceSentence[],
  localSimilarity?: (body: string, evidence: string) => Promise<number>
): Promise<{ items: LensItem[]; dropped: LensDrop[] }> {
  const refs = new Map(sentences.map((s) => [s.ref, s])),
    kept: LensItem[] = [],
    dropped: LensDrop[] = []
  for (const original of items) {
    const item = { ...original, evidence: [...new Set(original.evidence.filter((r) => refs.has(r)))] }
    const drop = (reason: LensDrop['reason'], extra: Partial<LensDrop> = {}): void => {
      dropped.push({ itemId: item.id, title: item.title, body: item.body, reason, ...extra })
    }
    if (!item.evidence.length) {
      drop('missing_reference')
      continue
    }
    const evidence = item.evidence.map((r) => refs.get(r)!.text).join('\n'),
      overlap = bigramOverlap(item.body, evidence)
    if (
      overlap < EVIDENCE_MIN_OVERLAP &&
      (!localSimilarity || (await localSimilarity(item.body, evidence).catch(() => 0)) < EVIDENCE_VECTOR_MIN)
    ) {
      drop('irrelevant', { overlap })
      continue
    }
    if (item.quote && !nearVerbatim(item.quote, evidence)) {
      drop('rewritten_quote', { field: 'quote', overlap })
      item.body = item.body.replace(item.quote, '').trim()
      delete item.quote
    }
    if (!item.body) {
      drop('irrelevant', { overlap: 0 })
      continue
    }
    kept.push(item)
  }
  return { items: kept, dropped }
}
