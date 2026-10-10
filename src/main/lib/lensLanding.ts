import {
  lectureNoteItems,
  lensItemCreatesRow,
  lensParagraph,
  lensRowCue,
  type EvidenceSentence,
  type LandingRule,
  type LensItem,
  type LensMapping
} from '@shared/lens'
import type { DocNode } from '@shared/types'
import { bigramOverlap } from './lensEvidence'

export function resolveLensOwner(
  owner: string | undefined,
  sentences: EvidenceSentence[],
  people: { id: string; name: string }[],
  participants: string[]
): { personId: string | null; name: string } {
  const value = owner?.trim() ?? '',
    speakers = sentences.filter((s) => s.speaker === value || s.name === value),
    identities = new Set(speakers.map((s) => s.personId))
  if (speakers.length) {
    const personId = identities.size === 1 ? speakers[0].personId : null
    const names = new Set(speakers.map((s) => s.name))
    return { personId, name: people.find((p) => p.id === personId)?.name ?? (names.size === 1 ? speakers[0].name : value) }
  }
  const preferred = people.filter((p) => participants.includes(p.id) && p.name === value),
    matches = preferred.length ? preferred : people.filter((p) => p.name === value)
  return matches.length === 1 ? { personId: matches[0].id, name: matches[0].name } : { personId: null, name: value }
}
export function duplicateLensItems(items: LensItem[], existing: LensItem[]): string[] {
  return items
    .filter((item) =>
      existing.some(
        (other) =>
          other.category === item.category && Math.min(bigramOverlap(item.body, other.body), bigramOverlap(other.body, item.body)) >= 0.82
      )
    )
    .map((item) => item.id)
}
export function canUndoLanding(appliedAt: number, now: number, unmodified: boolean): boolean {
  return unmodified && now >= appliedAt && now - appliedAt <= 10 * 60_000
}
export function mapLensLanding(
  rule: LandingRule,
  items: LensItem[],
  sentences: EvidenceSentence[],
  sourceId: string,
  _date: string
): LensMapping {
  const result: LensMapping = { rows: [], ops: [], actions: [], insights: [], concepts: [], progress: [], personNotes: [] }
  if (rule === 'lecture') result.concepts = items.filter((item) => item.category === 'concept')
  for (const item of rule === 'lecture' ? lectureNoteItems(items) : items) {
    if (item.category === 'action' && ['meeting', 'lecture', 'thought', 'todos'].includes(rule)) {
      result.actions.push(item)
      continue
    }
    if (item.category === 'progress' && rule === 'meeting') {
      result.progress.push(item)
    }
    if (rule === 'thought' && item.category === 'idea') {
      result.insights.push(item)
      continue
    }
    if (rule === 'todos') continue
    if (rule === 'person') {
      result.personNotes.push(item)
      continue
    }
    const refs = item.evidence.map((ref) => sentences.find((s) => s.ref === ref)).filter((s): s is EvidenceSentence => !!s)
    const links: DocNode[] = refs.flatMap((s) => [
      {
        type: 'text',
        text: ` ▶ ${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}`,
        marks: [{ type: 'link', attrs: { href: `jiwei://source/${encodeURIComponent(sourceId)}?t=${s.start}` } }]
      }
    ])
    const body = [item.body, item.quote ? `“${item.quote}”` : '', item.speaker ? `（${item.speaker}）` : ''].filter(Boolean).join('\n')
    if (item.category === 'link' && item.noteId)
      links.push({
        type: 'text',
        text: ` [[${item.title}]]`,
        marks: [{ type: 'link', attrs: { href: `jiwei://note/${encodeURIComponent(item.noteId)}` } }]
      })
    const cue = lensRowCue(rule, item)
    if (!lensItemCreatesRow(rule, item)) result.ops.push({ op: 'append_summary', nodes: [lensParagraph(`${item.title}\n${body}`, links)] })
    else {
      result.rows.push({ itemId: item.id, cue, body })
      result.ops.push({
        op: 'insert_row',
        afterRowId: null,
        cue: [lensParagraph(cue)],
        body: [lensParagraph(`${item.category === 'emphasis' && !body.startsWith('★ ') ? '★ ' : ''}${body}`, links)]
      })
    }
  }
  return result
}
