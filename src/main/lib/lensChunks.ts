import type { EvidenceSentence, LensItem } from '@shared/lens'
import { bigramOverlap } from './lensEvidence'

export function splitLensTranscript(sentences: EvidenceSentence[]): EvidenceSentence[][] {
  if (sentences.reduce((n, s) => n + s.text.length, 0) <= 12000) return [sentences]
  const result: EvidenceSentence[][] = []
  let from = 0
  while (from < sentences.length) {
    let to = from + 1
    while (to < sentences.length && sentences[to].start - sentences[from].start < 900) to++
    // 在目标时间附近向后找换人处；独白在句末切开，保证必定前进。
    const target = to
    while (
      to < sentences.length &&
      to - target < 20 &&
      sentences[to].start - sentences[target].start < 60 &&
      sentences[to - 1].speaker === sentences[to].speaker
    )
      to++
    if (to > target && (to === sentences.length || sentences[to - 1].speaker === sentences[to].speaker)) to = target
    result.push(sentences.slice(from, to))
    if (to === sentences.length) break
    let next = to - 1
    while (next > from && sentences[next - 1].end >= sentences[to - 1].end - 60) next--
    from = Math.max(from + 1, next)
  }
  return result
}
export function mergeLensItems(items: LensItem[]): LensItem[] {
  const result: LensItem[] = []
  for (const item of items) {
    const duplicate = result.find(
      (r) =>
        r.category === item.category &&
        r.owner === item.owner &&
        r.ownerPersonId === item.ownerPersonId &&
        r.speaker === item.speaker &&
        r.speakerPersonId === item.speakerPersonId &&
        r.actionId === item.actionId &&
        r.noteId === item.noteId &&
        Math.min(bigramOverlap(r.body, item.body), bigramOverlap(item.body, r.body)) >= 0.82
    )
    if (duplicate) duplicate.evidence = [...new Set([...duplicate.evidence, ...item.evidence])]
    else result.push({ ...item, evidence: [...item.evidence] })
  }
  return result.map((r, i) => ({ ...r, id: `i${i + 1}` }))
}
