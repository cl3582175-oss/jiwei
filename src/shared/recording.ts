import { z } from 'zod'

export type VoiceValidationKey =
  | 'invalidVector'
  | 'vectorDimension'
  | 'invalidCenter'
  | 'missingTrack'
  | 'partConflict'
  | 'partGap'
  | 'timelineGap'
  | 'duplicateTrack'
  | 'duplicatePart'
/** 纯算法只返回错误身份；在 IPC/任务边界按用户语言解释。 */
export class VoiceValidationError extends Error {
  constructor(readonly key: VoiceValidationKey) {
    super(`recording.validation.${key}`)
  }
}

export const RecordingId = z.string().uuid()
export const SpeakerLabel = z.string().regex(/^S\d{2,4}$/)
export const RecordingTrack = z.enum(['mic', 'system'])
export const RecordingScene = z.enum(['meeting', 'lecture', 'thought', 'unspecified'])
export type Track = z.infer<typeof RecordingTrack>
export type Scene = z.infer<typeof RecordingScene>
export type RecordingStatus = 'recording' | 'paused' | 'finalizing' | 'ready' | 'failed' | 'discarded'
export interface Marker {
  t: number
  kind: 'star' | 'decision' | 'todo'
  text: string
}
export interface PreviewCue {
  start: number
  end: number
  text: string
  track?: Track
}
export interface Recording {
  id: string
  sourceId: string | null
  noteId: string | null
  scene: Scene
  status: RecordingStatus
  tracks: Track[]
  startedAt: number
  durationMs: number
  markers: Marker[]
  participants: string[]
  extraHotwords: string
  localOnly: boolean
  preview: PreviewCue[]
  active: boolean
  error: string | null
}
export interface Person {
  id: string
  name: string
  isMe: boolean
  note: string
  voiceprints: number
}
export interface RecordingSpeaker {
  label: string
  personId: string | null
  name: string | null
  origin: 'auto' | 'user'
  confidence: number | null
  maybeMe: boolean
  sampleStart: number
  sampleEnd: number
  hasCentroid: boolean
  skipped: boolean
}
export interface VoiceStatus {
  state: 'missing' | 'downloading' | 'ready' | 'error' | 'unsupported'
  progress: number
  mirror: string | null
  speed: number | null
  message: string | null
  size: number
}
const EntityId = z.string().regex(/^[\w-]{1,128}$/)
export const RecordingBegin = z.object({
  scene: RecordingScene.exclude(['unspecified']),
  tracks: z
    .array(RecordingTrack)
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length),
  noteId: EntityId.nullable().optional(),
  participants: z.array(EntityId).max(100).default([]),
  extraHotwords: z.string().max(4000).default(''),
  localOnly: z.boolean()
})
export const RecordingChunk = z.object({
  id: RecordingId,
  track: RecordingTrack,
  sequence: z.number().int().min(0).max(999999),
  startMs: z
    .number()
    .finite()
    .nonnegative()
    .max(7 * 86400000),
  durationMs: z.number().finite().positive().max(60000),
  bytes: z.instanceof(Uint8Array).refine((v) => v.byteLength > 0 && v.byteLength <= 8 * 1024 * 1024)
})
export const RecordingMarker = z.object({
  t: z.number().finite().nonnegative(),
  kind: z.enum(['star', 'decision', 'todo']),
  text: z.string().max(1000).default('')
})
export const PersonInput = z.object({
  name: z.string().trim().min(1).max(100),
  note: z.string().max(2000).default(''),
  isMe: z.boolean().default(false)
})
export const SpeakerChoice = z.object({
  sourceId: EntityId,
  label: SpeakerLabel,
  personId: EntityId.nullable(),
  segmentId: EntityId.optional()
})
export const TranscriptFormat = z.enum(['md', 'srt', 'txt'])
export const speakerBody = (text: string): string => text.replace(/^［[^\r\n］]{1,120}］/, '')
export function rewriteSpeakerText(text: string, label: string, name: string | null): string {
  SpeakerLabel.parse(label)
  return `［${name?.replace(/[［］\r\n]/g, ' ').trim() || `说话人 ${Number(label.slice(1))}`}］${speakerBody(text)}`
}
export function correctionPair(before: string, after: string): { from: string; to: string } | null {
  if (before === after) return null
  let a = 0,
    b = 0
  while (a < Math.min(before.length, after.length) && before[a] === after[a]) a++
  while (b < Math.min(before.length, after.length) - a && before.at(-b - 1) === after.at(-b - 1)) b++
  // 一字错写扩为最短的两字词，避免把单个汉字当成热词。
  if (a > 0 && (before.length - a - b === 1 || after.length - a - b === 1) && /[\p{L}\p{N}]/u.test(before[a - 1])) a--
  const from = before.slice(a, before.length - b).trim(),
    to = after.slice(a, after.length - b).trim()
  return from.length >= 2 && from.length <= 20 && to.length >= 2 && to.length <= 20 ? { from, to } : null
}
export function transcriptTime(locator: Record<string, unknown>): [number, number] | null {
  const m = /^t=([\d.]+),([\d.]+)$/.exec(String(locator.value ?? ''))
  if (!m) return null
  const start = Number(m[1]),
    end = Number(m[2])
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start ? [start, end] : null
}
const time = (n: number): string => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`
const srtTime = (n: number): string => {
  const ms = Math.round(n * 1000)
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
export function transcriptExport(
  segments: { text: string; locator: Record<string, unknown> }[],
  format: z.infer<typeof TranscriptFormat>
): string {
  return segments
    .filter((s) => transcriptTime(s.locator))
    .map((s, i) => {
      const [start, end] = transcriptTime(s.locator)!,
        name = /^［([^］]+)］/.exec(s.text)?.[1] ?? '',
        body = speakerBody(s.text)
      if (format === 'srt') return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${name ? `${name}：` : ''}${body}\n\n`
      if (format === 'md') return `${name ? `**${name.replace(/[\\*_`<>]/g, '\\$&')}** ` : ''}[${time(start)}] ${body}\n`
      return `${name ? `${name}：` : ''}${body}\n`
    })
    .join('')
}
