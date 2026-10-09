export interface MossCue {
  start: number
  end: number
  text: string
  speaker: string | null
  part?: number
}

export interface MossChunk {
  start: number
  duration: number
}

export interface MossRecording {
  version: 1
  complete: true
  duration: number
  chunks: { audioStart: number; audioEnd: number; videoStart: number; rate: number }[]
}

interface MossSegment {
  kind: string
  locator: Record<string, unknown>
  text: string
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const round = (value: number): number => Math.round(value * 1000) / 1000

/** 不丢弃损坏的非空句子，避免用局部结果覆盖用户已有的完整文字稿。 */
export function parseMossOutput(raw: unknown): MossCue[] {
  if (!object(raw) || !Array.isArray(raw.transcription)) throw new Error('MOSS 输出缺少 transcription 数组')
  const cues: MossCue[] = []
  for (const [index, value] of raw.transcription.entries()) {
    if (!object(value) || typeof value.text !== 'string') throw new Error(`MOSS 第 ${index + 1} 句文字无效`)
    const text = value.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const offsets = value.offsets
    if (!object(offsets) || !finite(offsets.from) || !finite(offsets.to) || offsets.from < 0 || offsets.to <= offsets.from)
      throw new Error(`MOSS 第 ${index + 1} 句时间无效`)
    let speaker: string | null = null
    if (value.speaker !== undefined && value.speaker !== null && value.speaker !== '') {
      if (typeof value.speaker !== 'string') throw new Error(`MOSS 第 ${index + 1} 句说话人无效`)
      const match = /^\s*\(?Speaker\s+(\d{1,4})\)?\s*$/i.exec(value.speaker)
      if (!match) throw new Error(`MOSS 第 ${index + 1} 句说话人无效`)
      speaker = `S${String(Number(match[1])).padStart(2, '0')}`
    }
    cues.push({ start: offsets.from / 1000, end: offsets.to / 1000, text, speaker })
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function planMossChunks(duration: number): MossChunk[] {
  if (!finite(duration) || duration <= 0 || duration > 7 * 24 * 3600) throw new Error('录音时长无效')
  if (duration <= 85 * 60) return [{ start: 0, duration }]
  const chunks: MossChunk[] = []
  for (let start = 0; start < duration; start += 60 * 60 - 30) {
    chunks.push({ start, duration: Math.min(60 * 60, duration - start) })
    if (start + 60 * 60 >= duration) break
  }
  return chunks
}

const normalizedSpeech = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/[\p{P}\p{Z}\s]/gu, '')
    .toLocaleLowerCase()
const middle = (cue: MossCue): number => (cue.start + cue.end) / 2

/**
 * 重叠段以中点划分归属；先匹配同一句再划界，避免两次时间戳略有偏差时两边都把它丢掉。
 * 同一句只在重叠时间附近去重，说话人编号不用于跨段身份判断。
 */
export function mergeMossChunks(parts: { chunk: MossChunk; cues: MossCue[] }[]): MossCue[] {
  let result: MossCue[] = []
  let previousEnd = 0
  for (const [index, { chunk, cues }] of parts.entries()) {
    const incoming = cues.map((cue) => ({
      ...cue,
      start: round(cue.start + chunk.start),
      end: round(cue.end + chunk.start),
      ...(parts.length > 1 ? { part: index + 1 } : {})
    }))
    if (index && previousEnd > chunk.start) {
      const boundary = (chunk.start + previousEnd) / 2
      const matchedOld = new Set<MossCue>()
      const matchedNew = new Set<MossCue>()
      const tail = result.filter((cue) => cue.end >= chunk.start - 2)
      for (const cue of incoming) {
        if (cue.start > previousEnd + 2) break
        const text = normalizedSpeech(cue.text)
        const duplicate = tail
          .filter(
            (old) =>
              !matchedOld.has(old) &&
              normalizedSpeech(old.text) === text &&
              Math.min(old.end, cue.end) + 2 >= Math.max(old.start, cue.start)
          )
          .sort((a, b) => Math.abs(middle(a) - middle(cue)) - Math.abs(middle(b) - middle(cue)))[0]
        if (duplicate) {
          matchedOld.add(duplicate)
          matchedNew.add(cue)
        }
      }
      result = result.filter((cue) => middle(cue) < boundary || matchedOld.has(cue))
      result.push(...incoming.filter((cue) => !matchedNew.has(cue) && middle(cue) >= boundary))
    } else result.push(...incoming)
    previousEnd = chunk.start + chunk.duration
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** 只有录制端确认完整且时间映射连续的音轨才允许替换整份文字稿。 */
export function parseMossRecording(raw: unknown): MossRecording {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    raw.complete !== true ||
    !finite(raw.duration) ||
    raw.duration <= 0 ||
    raw.duration > 7 * 24 * 3600 ||
    !Array.isArray(raw.chunks) ||
    !raw.chunks.length ||
    raw.chunks.length > 100_000
  )
    throw new Error('尚无完整录音，请从开头以本地转写方式播放到结束后再精修')
  const chunks: MossRecording['chunks'] = []
  let audioEnd = 0
  let videoEnd = 0
  for (const chunk of raw.chunks) {
    if (
      !object(chunk) ||
      !finite(chunk.audioStart) ||
      !finite(chunk.audioEnd) ||
      !finite(chunk.videoStart) ||
      !finite(chunk.rate) ||
      chunk.audioStart < 0 ||
      chunk.audioEnd <= chunk.audioStart ||
      chunk.videoStart < 0 ||
      chunk.rate < 0.0625 ||
      chunk.rate > 16 ||
      Math.abs(chunk.audioStart - audioEnd) > 0.1 ||
      Math.abs(chunk.videoStart - videoEnd) > 2
    )
      throw new Error('录音时间轴不完整，请重新从开头录制课程')
    chunks.push({ audioStart: chunk.audioStart, audioEnd: chunk.audioEnd, videoStart: chunk.videoStart, rate: chunk.rate })
    audioEnd = chunk.audioEnd
    videoEnd = chunk.videoStart + (chunk.audioEnd - chunk.audioStart) * chunk.rate
  }
  if (Math.abs(videoEnd - raw.duration) > 2) throw new Error('录音未覆盖完整课程，请播放到结束后再精修')
  return { version: 1, complete: true, duration: raw.duration, chunks }
}

export function mapMossToVideo(cues: MossCue[], recording: MossRecording): MossCue[] {
  const last = recording.chunks[recording.chunks.length - 1]
  const map = (time: number): number => {
    if (!finite(time) || time < 0 || time > last.audioEnd + 0.1) throw new Error('MOSS 时间戳超出录音范围，原文字稿已保留')
    const chunk = recording.chunks.find((part) => time <= part.audioEnd + 0.001) ?? last
    return round(Math.min(recording.duration, chunk.videoStart + (Math.min(time, chunk.audioEnd) - chunk.audioStart) * chunk.rate))
  }
  return cues.map((cue) => ({ ...cue, start: map(cue.start), end: map(cue.end) }))
}

export function mergeMossSegments(current: MossSegment[], cues: MossCue[]): MossSegment[] {
  return [
    ...current.filter((segment) => segment.kind !== 'transcript'),
    ...[...cues]
      .sort((a, b) => a.start - b.start)
      .map((cue) => ({
        kind: 'transcript',
        locator: {
          type: 'FragmentSelector',
          conformsTo: 'http://www.w3.org/TR/media-frags/',
          value: `t=${round(cue.start)},${round(cue.end)}`,
          ...(cue.speaker ? { speaker: cue.speaker } : {}),
          ...(cue.part ? { speakerPart: cue.part } : {})
        },
        text: `${cue.speaker ? `［说话人 ${Number(cue.speaker.slice(1))}］` : ''}${cue.text}`
      }))
  ]
}

export function mossTranscriptRevision(current: MossSegment[]): string {
  // 正文或幻灯片插入会改变 ordinal，因此只冻结用户实际能修改的转写内容与定位。
  return JSON.stringify(current.filter((segment) => segment.kind === 'transcript').map(({ locator, text }) => ({ locator, text })))
}

const STOP_WORDS = new Set([
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '就是',
  '所以',
  '然后',
  '可以',
  '一个',
  '什么',
  '以及',
  '进行',
  '的',
  '与',
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'have',
  'will',
  'for',
  'are'
])

/** 热词只提供词汇提示；限制数量和长度，防止长资料挤占模型的上下文。 */
export function buildMossHotwords(concepts: string[], title: string, texts: string[]): string {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const words = (text: string): string[] => [...segmenter.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment)
  const frequency = new Map<string, number>()
  let remaining = 200_000
  for (const text of texts) {
    if (remaining <= 0) break
    const sample = text.slice(0, remaining)
    remaining -= sample.length
    for (const word of words(sample)) frequency.set(word, (frequency.get(word) ?? 0) + 1)
  }
  const frequent = [...frequency]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
  const result = new Map<string, string>()
  for (const candidate of [...concepts, ...words(title), ...frequent]) {
    const word = candidate
      .replace(/[,，\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
    const key = word.normalize('NFKC').toLocaleLowerCase()
    if (word.length < 2 || !/[\p{L}]/u.test(word) || STOP_WORDS.has(key) || result.has(key)) continue
    result.set(key, word)
    if (result.size === 30) break
  }
  return [...result.values()].join(',')
}
