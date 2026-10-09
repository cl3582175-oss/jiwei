// 网课的纯时间轴与关键帧规则：隔离脚本和主进程共用，避免时间换算与证据判断各算一套。
export interface CourseCue {
  start: number
  end: number
  text: string
}
export interface CourseSegment {
  kind: string
  locator: Record<string, unknown>
  text: string
}
export interface FrameHash {
  hash: bigint
  mean: number
}
export interface SlideState {
  saved: bigint | null
  candidate: bigint | null
  since: number
}

/** 32×32 灰度按小区域平均到 9×8，再比较左右亮度，得到 64 位 dHash。 */
export function frameHash(gray: Uint8Array): FrameHash {
  if (gray.length !== 1024) throw new Error('Expected 32×32 grayscale frame')
  const cells: number[] = []
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) {
      let sum = 0
      let count = 0
      for (let yy = y * 4; yy < (y + 1) * 4; yy++)
        for (let xx = Math.floor((x * 32) / 9); xx < Math.floor(((x + 1) * 32) / 9); xx++) {
          sum += gray[yy * 32 + xx]
          count++
        }
      cells.push(sum / count)
    }
  let hash = 0n
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | BigInt(cells[y * 9 + x] > cells[y * 9 + x + 1])
  return { hash, mean: gray.reduce((a, b) => a + b, 0) / gray.length }
}

export function hamming(a: bigint, b: bigint): number {
  let diff = a ^ b
  let n = 0
  while (diff) {
    diff &= diff - 1n
    n++
  }
  return n
}

export function advanceSlide(previous: SlideState | null, frame: FrameHash, now: number): { state: SlideState; save: boolean } {
  const state = previous ?? { saved: null, candidate: null, since: now }
  if (frame.mean < 8 || (state.saved !== null && hamming(state.saved, frame.hash) < 10))
    return { state: { ...state, candidate: null }, save: false }
  if (state.candidate === null || hamming(state.candidate, frame.hash) > 5 || now < state.since)
    return { state: { ...state, candidate: frame.hash, since: now }, save: false }
  if (now - state.since < 2) return { state, save: false }
  return { state: { saved: frame.hash, candidate: null, since: now }, save: true }
}

export function segmentTime(s: Pick<CourseSegment, 'locator'>): [number, number] | null {
  const m = /^t=(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?$/.exec(String(s.locator.value ?? ''))
  if (!m) return null
  const start = Number(m[1]),
    end = Number(m[2] ?? m[1])
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [start, end] : null
}

export function mapChunkCues(cues: CourseCue[], videoStart: number, rate: number): CourseCue[] {
  return cues.map((c) => ({ ...c, start: videoStart + c.start * rate, end: videoStart + c.end * rate }))
}

export function mergeTranscript(current: CourseSegment[], cues: CourseCue[], append = false): CourseSegment[] {
  const fresh = cues
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end >= c.start && c.text.trim())
    .map((c) => ({
      kind: 'transcript',
      text: c.text.trim(),
      locator: {
        type: 'FragmentSelector',
        conformsTo: 'http://www.w3.org/TR/media-frags/',
        value: `t=${+c.start.toFixed(3)},${+c.end.toFixed(3)}`
      }
    }))
  const transcripts = [...(append ? current.filter((s) => s.kind === 'transcript') : []), ...fresh]
  const seen = new Set<string>()
  return [
    ...current.filter((s) => s.kind !== 'transcript'),
    ...transcripts
      .sort((a, b) => (segmentTime(a)?.[0] ?? 0) - (segmentTime(b)?.[0] ?? 0))
      .filter((s) => {
        const key = `${s.locator.value}:${s.text}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  ]
}

export function supportedRows<T extends { t: number }>(rows: T[], segments: CourseSegment[]): T[] {
  const ranges = segments
    .filter((s) => s.kind === 'transcript')
    .map(segmentTime)
    .filter((t): t is [number, number] => !!t)
  return rows.filter((r) => Number.isFinite(r.t) && r.t >= 0 && ranges.some(([start, end]) => r.t >= start - 5 && r.t <= end + 5))
}
