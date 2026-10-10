import { z } from 'zod'
import { RecordingId, RecordingTrack, VoiceValidationError } from '@shared/recording'

export const MAX_RECORDING_CHUNK = 8 * 1024 * 1024
const Part = z.object({
  track: RecordingTrack,
  sequence: z.number().int().min(0).max(999999),
  startMs: z.number().finite().nonnegative(),
  durationMs: z.number().finite().positive().max(60000),
  size: z.number().int().positive().max(MAX_RECORDING_CHUNK),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
const Manifest = z.object({
  version: z.literal(1),
  id: RecordingId,
  tracks: z.array(RecordingTrack).min(1).max(2),
  parts: z.array(Part).max(100000)
})
export type RecordingManifest = z.infer<typeof Manifest>
export type RecordingPart = z.infer<typeof Part>
export function partName(track: string, sequence: number): string {
  RecordingTrack.parse(track)
  z.number().int().min(0).max(999999).parse(sequence)
  return `${track}-${String(sequence).padStart(6, '0')}.webm`
}
export function appendRecordingPart(manifest: RecordingManifest, input: RecordingPart): RecordingManifest {
  const part = Part.parse(input)
  if (!manifest.tracks.includes(part.track)) throw new VoiceValidationError('missingTrack')
  const previous = manifest.parts.filter((p) => p.track === part.track)
  const duplicate = previous.find((p) => p.sequence === part.sequence)
  if (duplicate) {
    if (JSON.stringify(duplicate) !== JSON.stringify(part)) throw new VoiceValidationError('partConflict')
    return manifest
  }
  if (part.sequence !== previous.length) throw new VoiceValidationError('partGap')
  const last = previous.at(-1)
  if (last && Math.abs(part.startMs - last.startMs - last.durationMs) > 2000) throw new VoiceValidationError('timelineGap')
  return { ...manifest, parts: [...manifest.parts, part] }
}
export function parseRecordingManifest(raw: unknown): RecordingManifest {
  const parsed = Manifest.parse(raw)
  if (new Set(parsed.tracks).size !== parsed.tracks.length) throw new VoiceValidationError('duplicateTrack')
  let checked: RecordingManifest = { ...parsed, parts: [] }
  for (const part of parsed.parts) {
    const next = appendRecordingPart(checked, part)
    if (next === checked) throw new VoiceValidationError('duplicatePart')
    checked = next
  }
  return checked
}
