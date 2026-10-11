import type { DiscoveryScore } from '@shared/discover'
export function feedbackAllowed(url: string, allowed: Set<string>): boolean {
  const internal = /^jiwei:\/\/(note|source)\/([\w-]+)$/.exec(url)
  return internal ? allowed.has(`${internal[1]}:${internal[2]}`) : /^https?:\/\//i.test(url)
}
export function choosePicks<T extends { id: string; url: string; score: DiscoveryScore }>(
  items: T[],
  limit: number,
  exams: Set<string>
): T[] {
  if (limit <= 0) return []
  const sorted = items
    .filter((i) => i.score.relevance >= 2 && !(i.score.news && i.score.goalIds.some((id) => exams.has(id))))
    .sort(
      (a, b) =>
        b.score.relevance * 2 +
        b.score.novelty +
        b.score.credibility +
        b.score.depth -
        (a.score.relevance * 2 + a.score.novelty + a.score.credibility + a.score.depth)
    )
  const selected: T[] = [],
    counts = new Map<string, number>()
  const add = (i: T): void => {
    const host = new URL(i.url).hostname
    if (selected.length >= limit || selected.some((p) => p.id === i.id) || (counts.get(host) ?? 0) >= 2) return
    selected.push(i)
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  const diverse = sorted.find((i) => i.score.diverse)
  if (diverse) add(diverse)
  sorted.forEach(add)
  return selected.sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b))
}
