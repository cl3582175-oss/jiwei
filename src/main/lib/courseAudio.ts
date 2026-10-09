export interface CourseAudioPart {
  sequence: number
  start: number
  end: number
  rate: number
  elapsed: number
  final: boolean
  audioDuration?: number
}

export interface CourseAudioManifest {
  version: 1
  complete: boolean
  duration: number
  chunks: { audioStart: number; audioEnd: number; videoStart: number; rate: number }[]
}

export function courseAudioManifest(parts: CourseAudioPart[], duration: number): CourseAudioManifest {
  let complete = Number.isFinite(duration) && duration > 0 && parts.length > 0 && parts.at(-1)?.final === true
  let audioTime = 0
  let videoEnd = 0
  let missing = 0
  let repeated = 0
  const chunks: CourseAudioManifest['chunks'] = []
  for (const [index, part] of parts.entries()) {
    const decoded = part.audioDuration ?? 0
    if (
      ![part.start, part.end, part.rate, part.elapsed, decoded].every(Number.isFinite) ||
      decoded <= 0 ||
      part.rate <= 0 ||
      part.rate > 16 ||
      part.start < 0 ||
      part.sequence !== index ||
      part.elapsed <= 0 ||
      Math.abs(decoded - part.elapsed) > 2 ||
      (part.final && index !== parts.length - 1)
    ) {
      complete = false
      continue
    }
    const gap = part.start - videoEnd
    missing += Math.max(0, gap)
    repeated += Math.max(0, -gap)
    if (Math.abs(gap) > 2 || (index === 0 && part.start > 0.5)) complete = false
    const audioStart = audioTime
    audioTime += decoded
    videoEnd = part.start + decoded * part.rate
    if (Math.abs(videoEnd - part.end) > 2) complete = false
    chunks.push({ audioStart, audioEnd: audioTime, videoStart: part.start, rate: part.rate })
  }
  missing += Math.max(0, duration - videoEnd)
  repeated += Math.max(0, videoEnd - duration)
  // 编码边界允许轻微抖动，但不能让每一块各漏两秒仍被误判为整节课已录全。
  complete = complete && missing <= 2 && repeated <= 2 && Math.abs(videoEnd - duration) <= 2
  return { version: 1, complete, duration, chunks }
}

export function hasAppliedAudioPart(
  segments: { kind: string; locator: Record<string, unknown> }[],
  capture: string,
  sequence: number
): boolean {
  return segments.some((s) => s.kind === 'transcript' && s.locator.audioCapture === capture && s.locator.audioSequence === sequence)
}

export function appendCourseAudioPart(
  current: CourseSegment[],
  cues: CourseCue[],
  part: Pick<CourseAudioPart, 'start' | 'rate' | 'sequence'>,
  capture: string
): CourseSegment[] {
  const fresh = mergeTranscript([], mapChunkCues(cues, part.start, part.rate)).map((segment) => ({
    ...segment,
    locator: { ...segment.locator, audioCapture: capture, audioSequence: part.sequence }
  }))
  // 回跳后仍按课程时间展示，复用字幕的稳定去重，同时保留旧段的人工修改与录音回执。
  return mergeTranscript([...current, ...fresh], [], true)
}
import { mapChunkCues, mergeTranscript, type CourseCue, type CourseSegment } from '@shared/course'
