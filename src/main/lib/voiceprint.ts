import type { MossCue } from './moss'
import type { Track } from '@shared/recording'
import { VoiceValidationError } from '@shared/recording'

export const REASSIGN_MIN = 0.72
export const REASSIGN_MARGIN = 0.12
export const UNCERTAIN_BELOW = 0.55
export const MERGE_MIN = 0.7
export const MATCH_PERSON_MIN = 0.72
export const VOICEPRINT_MODEL = 'campplus-zh-cn-16k-common-v1'
export interface VoiceCue extends MossCue {
  embedding?: number[]
  uncertain?: boolean
  track?: Track
  personId?: string
  personName?: string
}
function check(v: number[]): void {
  if (v.length < 2 || v.length > 4096 || v.some((n) => !Number.isFinite(n))) throw new VoiceValidationError('invalidVector')
}
export function cosine(a: number[], b: number[]): number {
  check(a)
  check(b)
  if (a.length !== b.length) throw new VoiceValidationError('vectorDimension')
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0) * b.reduce((s, x) => s + x * x, 0))
  return norm > 1e-10 ? a.reduce((s, x, i) => s + x * b[i], 0) / norm : 0
}
export function centroid(items: { embedding: number[]; duration: number }[]): number[] {
  if (!items.length) return []
  const result = Array<number>(items[0].embedding.length).fill(0)
  for (const { embedding, duration } of items) {
    check(embedding)
    if (embedding.length !== result.length || !Number.isFinite(duration) || duration <= 0) throw new VoiceValidationError('invalidCenter')
    embedding.forEach((v, i) => {
      result[i] += v * duration
    })
  }
  const norm = Math.hypot(...result)
  return result.map((v) => (norm > 1e-10 ? v / norm : 0))
}
const key = (cue: VoiceCue): string => `${cue.part ?? 1}:${cue.speaker}`
function centers(cues: VoiceCue[]): Map<string, number[]> {
  const grouped = new Map<string, { embedding: number[]; duration: number }[]>()
  for (const c of cues)
    if (c.speaker && c.embedding && c.end - c.start >= 1) {
      grouped.set(key(c), [...(grouped.get(key(c)) ?? []), { embedding: c.embedding, duration: c.end - c.start }])
    }
  return new Map([...grouped].map(([k, v]) => [k, centroid(v)]))
}
export function reviewSpeakers(cues: VoiceCue[]): VoiceCue[] {
  const grouped = centers(cues)
  const sums = new Map<string, { sum: number[]; count: number }>()
  for (const c of cues)
    if (c.speaker && c.embedding && c.end - c.start >= 1) {
      const item = sums.get(key(c)) ?? { sum: c.embedding.map(() => 0), count: 0 }
      c.embedding.forEach((v, i) => {
        item.sum[i] += v * (c.end - c.start)
      })
      item.count++
      sums.set(key(c), item)
    }
  const result = cues.map((cue) => {
    if (!cue.speaker || !cue.embedding || cue.end - cue.start < 1) return { ...cue }
    // 比较当前句时移除它自己的贡献。长错标段不能把本标签中心拉向自己，
    // 再以很高的 own 掩盖错误；单例仍使用原中心。求和一次，逐句 O(dim)。
    const peers = sums.get(key(cue))
    const own = peers && peers.count > 1 ? peers.sum.map((v, i) => v - cue.embedding![i] * (cue.end - cue.start)) : grouped.get(key(cue))
    const ownScore = own ? cosine(cue.embedding, own) : 0
    const other = [...grouped]
      .filter(([k]) => k.startsWith(`${cue.part ?? 1}:`) && k !== key(cue))
      .map(([k, v]) => ({ speaker: k.split(':')[1], score: cosine(cue.embedding!, v) }))
      .sort((a, b) => b.score - a.score)[0]
    if (other && other.score >= REASSIGN_MIN && other.score - ownScore >= REASSIGN_MARGIN) return { ...cue, speaker: other.speaker }
    return { ...cue, ...(Math.max(ownScore, other?.score ?? 0) < UNCERTAIN_BELOW ? { uncertain: true } : {}) }
  })
  return result.map((cue, i) => {
    if (cue.end - cue.start >= 1 && cue.embedding) return cue
    const neighbor = cues
      .map((c, j) => ({ c, j }))
      .filter(({ c }) => key(c) === key(cues[i]) && c.embedding && c.end - c.start >= 1)
      .sort((a, b) => Math.abs(a.c.start - cue.start) - Math.abs(b.c.start - cue.start))[0]
    return neighbor
      ? { ...cue, speaker: result[neighbor.j].speaker, embedding: neighbor.c.embedding, uncertain: result[neighbor.j].uncertain }
      : { ...cue, uncertain: true }
  })
}
export function alignSpeakers(cues: VoiceCue[]): { cues: VoiceCue[]; speakers: { label: string; embedding: number[] }[] } {
  const grouped = centers(cues),
    stable = new Map<string, { embedding: number[]; duration: number }[]>(),
    mapping = new Map<string, string>()
  for (const part of [...new Set(cues.map((c) => c.part ?? 1))]) {
    const labels = [...new Set(cues.filter((c) => (c.part ?? 1) === part && c.speaker).map((c) => key(c)))],
      used = new Set<string>()
    const candidates = labels
      .flatMap((local) =>
        [...stable].map(([label, embeddings]) => ({
          local,
          label,
          score: grouped.has(local) ? cosine(grouped.get(local)!, centroid(embeddings)) : -1
        }))
      )
      .sort((a, b) => b.score - a.score)
    for (const match of candidates)
      if (match.score >= MERGE_MIN && !mapping.has(match.local) && !used.has(match.label)) {
        mapping.set(match.local, match.label)
        used.add(match.label)
      }
    for (const local of labels) {
      if (!mapping.has(local)) mapping.set(local, `S${String(stable.size + 1).padStart(2, '0')}`)
      const label = mapping.get(local)!,
        embedding = grouped.get(local)
      const duration = cues.filter((c) => key(c) === local && c.end - c.start >= 1).reduce((n, c) => n + c.end - c.start, 0)
      stable.set(label, [...(stable.get(label) ?? []), ...(embedding ? [{ embedding, duration: Math.max(1, duration) }] : [])])
    }
  }
  return {
    cues: cues.map((c) => ({ ...c, speaker: mapping.get(key(c)) ?? c.speaker })),
    speakers: [...stable].map(([label, items]) => ({ label, embedding: centroid(items) }))
  }
}
export function matchPerson(
  embedding: number[],
  people: { id: string; isMe: boolean; embeddings: number[][] }[],
  participants?: string[]
): { personId: string; confidence: number } | null {
  const ranked = people
    .filter((p) => !participants?.length || p.isMe || participants.includes(p.id))
    .map((p) => ({ personId: p.id, confidence: Math.max(-1, ...p.embeddings.map((v) => cosine(embedding, v))) }))
    .sort((a, b) => b.confidence - a.confidence)
  return ranked[0]?.confidence >= MATCH_PERSON_MIN && ranked[0].confidence - (ranked[1]?.confidence ?? -1) >= 0.05 ? ranked[0] : null
}
export function trackHint(mic: number, system: number): Track | undefined {
  if (mic > 1e-6 && mic > system * 4) return 'mic'
  if (system > 1e-6 && system > mic * 4) return 'system'
  return undefined
}
