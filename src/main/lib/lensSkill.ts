import { stringify } from 'yaml'
import { LensLandingRule, LensOutput } from '@shared/lens'
import type { LensInfo } from '@shared/lens'

export function validateLensMetadata(metadata: Record<string, string>): Pick<LensInfo, 'output' | 'landing' | 'scenes'> {
  if (metadata.kind !== 'lens') throw new Error('Invalid lens kind')
  const output = LensOutput.parse(metadata.output),
    landing = LensLandingRule.parse(metadata.landing),
    scenes = (metadata.scenes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  if (scenes.some((s) => !['meeting', 'lecture', 'thought', 'unspecified'].includes(s))) throw new Error('Invalid lens scenes')
  return { output, landing, scenes }
}
export function createLensSkill(
  id: string,
  title: string,
  instruction: string,
  metadata: { output?: LensInfo['output']; landing?: LensInfo['landing']; scenes?: string[] } = {}
): string {
  if (
    !/^lens-(?:[a-z][a-z0-9-]{0,48}|[a-f0-9]{8})$/.test(id) ||
    title.length < 1 ||
    title.length > 40 ||
    instruction.trim().length < 1 ||
    instruction.length > 2000
  )
    throw new Error('Invalid lens input')
  const meta = {
    kind: 'lens',
    title,
    output: metadata.output ?? 'items',
    landing: metadata.landing ?? 'append',
    scenes: (metadata.scenes ?? []).join(',')
  }
  validateLensMetadata(meta)
  return `---\n${stringify({ name: id, description: title, metadata: meta }).trimEnd()}\n---\n\n${instruction.trim()}\n`
}
