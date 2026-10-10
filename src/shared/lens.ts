import { z } from 'zod'
import type { ActionItem, DocNode, ProposalOp, Source } from './types'
import type { Person, Scene } from './recording'

export const LensOutput = z.enum(['meeting', 'lecture', 'thought', 'items', 'brief'])
export const LensLandingRule = z.enum(['meeting', 'lecture', 'thought', 'todos', 'quiz', 'append', 'person'])
const text = z.string().max(8000)
export const EvidenceRefs = z
  .array(z.string().regex(/^u\d{1,7}$/))
  .min(1)
  .max(8)
// 文件只提供任务指令；输出结构由代码控制，用户技能不能扩大写入权限。
export const LensEntrySchema = z.object({
  title: z.string().max(200),
  body: text,
  evidence: EvidenceRefs,
  cue: z.string().max(1000).optional(),
  quote: z.string().max(2000).optional(),
  owner: z.string().max(100).optional(),
  dueQuote: z.string().max(200).optional(),
  speaker: z.string().max(100).optional(),
  noteId: z.string().max(128).optional(),
  relation: z.enum(['similar', 'contradicts']).optional(),
  actionId: z.string().max(128).optional()
})
const entries = z.array(LensEntrySchema).max(500)
export const MeetingOutput = z.object({
  topic: LensEntrySchema,
  agendas: entries,
  decisions: entries,
  actions: entries,
  questions: entries,
  risks: entries,
  progress: entries
})
export const LectureOutput = z.object({
  course: z.string().max(200),
  lecture: z.string().max(100),
  outline: entries,
  concepts: entries,
  examples: entries,
  emphasis: entries,
  qa: entries,
  assignments: entries,
  rows: entries
})
export const ThoughtOutput = z.object({ paragraphs: entries, ideas: entries, questions: entries, plans: entries, links: entries })
export const ItemsOutput = z.object({
  items: z.array(LensEntrySchema.extend({ category: z.enum(['action', 'decision', 'quiz', 'viewpoint', 'topic', 'item']) })).max(500)
})
export const BriefOutput = z.object({ sentences: z.tuple([LensEntrySchema, LensEntrySchema, LensEntrySchema]) })
export const LENS_SCHEMAS = {
  meeting: MeetingOutput,
  lecture: LectureOutput,
  thought: ThoughtOutput,
  items: ItemsOutput,
  brief: BriefOutput
}
export type LensOutputId = z.infer<typeof LensOutput>
export type LandingRule = z.infer<typeof LensLandingRule>
export type LensCategory =
  | 'topic'
  | 'agenda'
  | 'decision'
  | 'action'
  | 'question'
  | 'risk'
  | 'progress'
  | 'outline'
  | 'concept'
  | 'example'
  | 'emphasis'
  | 'qa'
  | 'row'
  | 'paragraph'
  | 'idea'
  | 'link'
  | 'quiz'
  | 'viewpoint'
  | 'item'
  | 'brief'
export interface LensItem extends z.infer<typeof LensEntrySchema> {
  id: string
  category: LensCategory
  ownerPersonId?: string | null
  ownerName?: string
  dueDate?: string | null
  speakerPersonId?: string | null
  completeAction?: boolean
}
export interface EvidenceSentence {
  ref: string
  segmentId: string
  start: number
  end: number
  speaker: string
  name: string
  personId: string | null
  text: string
}
export interface LensDrop {
  itemId: string
  title: string
  body: string
  reason: 'missing_reference' | 'irrelevant' | 'rewritten_quote' | 'limit' | 'invalid_candidate'
  field?: string
  overlap?: number
}
export interface LensResult {
  items: LensItem[]
  sentences: EvidenceSentence[]
  course?: string
  lecture?: string
  noteCandidates: { id: string; title: string; excerpt: string }[]
  actionCandidates: { id: string; title: string; ownerName: string | null; dueAt: number | null }[]
}
export interface LensStats {
  count: number
  dropped: LensDrop[]
  segments: number
  segmentMs: number[]
  estimatedCost: number | null
  error?: string
}
export interface SceneGuess {
  scene: Exclude<Scene, 'unspecified'>
  confidence: number
  reason: string
}
export const SceneGuessSchema = z.object({
  scene: z.enum(['meeting', 'lecture', 'thought']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(1000)
})
export interface LensInfo {
  id: string
  title: string
  instruction: string
  output: LensOutputId
  landing: LandingRule
  scenes: string[]
  source: 'builtin' | 'user'
  hash: string
}
export interface Derivation {
  id: string
  sourceId: string
  lens: string
  lensTitle: string
  lensHash: string
  params: LensParams
  model: string
  transcriptRevision: string
  status: 'queued' | 'running' | 'ready' | 'failed' | 'stale' | 'canceled'
  result: LensResult | null
  stats: LensStats | null
  summary: string
  createdAt: number
  jobId: string | null
  runAfter: number
  landing: LandingRule
}
export const LensParamsSchema = z.object({
  topic: z.string().max(500).optional(),
  personId: z.string().max(128).optional(),
  instruction: z.string().trim().min(1).max(2000).optional()
})
export type LensParams = z.infer<typeof LensParamsSchema>
export const LensRun = z.object({
  sourceId: z.string().max(128),
  lens: z.string().max(64),
  params: LensParamsSchema.default({}),
  offPeak: z.boolean().default(false)
})
export const LensSave = z.object({
  title: z.string().min(1).max(40),
  instruction: z.string().trim().min(1).max(2000),
  copyFrom: z.string().max(64).optional()
})
export const LensReviewed = z.object({
  id: z.string().max(128),
  title: z.string().max(200),
  body: z.string().min(1).max(8000),
  cue: z.string().max(1000).optional(),
  ownerPersonId: z.string().max(128).nullable().optional(),
  ownerName: z.string().max(100).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  completeAction: z.boolean().default(false)
})
export const LensLand = z.object({
  derivationId: z.string().max(128),
  items: z.array(LensReviewed).min(1).max(500),
  noteId: z.string().max(128).nullable().default(null),
  personId: z.string().max(128).optional()
})
export interface LensOrigin {
  derivationId: string
  itemId: string
  sourceId: string
  t: number
}
export interface LandingObject {
  kind: 'action' | 'insight' | 'concept' | 'progress' | 'person' | 'note'
  id: string
  itemId: string
  snapshot: string
}
export interface Landing {
  id: string
  derivationId: string
  noteId: string | null
  proposalId: string | null
  undoProposalId: string | null
  status: 'pending' | 'applied' | 'undoing' | 'undone'
  items: LensItem[]
  objects: LandingObject[]
  blocks: { id: string; snapshot: string }[]
  createdAt: number
  appliedAt: number | null
  canUndo: boolean
}
export interface LensMapping {
  rows: { itemId: string; cue: string; body: string }[]
  ops: ProposalOp[]
  actions: LensItem[]
  insights: LensItem[]
  concepts: LensItem[]
  progress: LensItem[]
  personNotes: LensItem[]
}
/** 行动项的原话里是否有承诺或指派的表述；没有时多半只是建议，审阅时默认不勾选 */
export function lensActionCommitted(item: LensItem, sentences: EvidenceSentence[]): boolean {
  if (item.category !== 'action') return true
  if (item.dueQuote || item.owner || item.ownerName) return true
  const text = [item.body, ...item.evidence.map((ref) => sentences.find((s) => s.ref === ref)?.text ?? '')].join(' ')
  return /我来|我会|我要|我们|咱们|你来|负责|安排|请|下周|明天|今天|周[一二三四五六日天]|之前|截止|月底|计划|打算|准备|待办|记得|回头|\b(I|we)('ll| will)|\btodo\b|deadline|by (monday|tuesday|wednesday|thursday|friday|tomorrow)/i.test(
    text
  )
}
export function lensItemCreatesRow(rule: LandingRule, item: LensItem): boolean {
  if (['append', 'person', 'todos'].includes(rule)) return false
  if (item.category === 'action' && ['meeting', 'lecture', 'thought'].includes(rule)) return false
  if (rule === 'thought' && item.category === 'idea') return false
  if (rule === 'lecture' && ['outline', 'example'].includes(item.category)) return false
  return !(rule === 'meeting' && ['topic', 'question', 'risk', 'progress'].includes(item.category))
}
export function lensRowCue(rule: LandingRule, item: LensItem): string {
  if (rule === 'lecture' || rule === 'quiz') return item.cue ?? (/[?？]$/.test(item.title) ? item.title : `${item.title}？`)
  return item.category === 'decision' ? '决策' : item.title
}
/**
 * 课堂落地：一个知识点只成一行、一张卡片。
 * 问答、概念、考点、例子与某个康奈尔行引用了同一段原话时并入该行（考点加 ★ 与原话，例子写成“例：”）；
 * 没有对应行的问答、概念、考点单独成行；大纲与无归属的例子进总结栏（见 lensItemCreatesRow）。
 * 概念事件仍按原条目登记。
 */
export function lectureNoteItems(items: LensItem[]): LensItem[] {
  const merged = items.map((item) => ({ ...item, evidence: [...item.evidence] })),
    removed = new Set<string>()
  const rows = merged.filter((item) => item.category === 'row')
  const host = (item: LensItem): LensItem | undefined =>
    rows
      .map((row) => ({ row, n: row.evidence.filter((ref) => item.evidence.includes(ref)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)[0]?.row
  for (const item of merged) {
    if (!['qa', 'concept', 'emphasis', 'example'].includes(item.category)) continue
    const row = host(item)
    if (!row) continue
    if (item.category === 'emphasis') {
      if (!row.body.startsWith('★ ')) row.body = `★ ${row.body}`
      if (item.quote && item.quote !== row.quote) row.body += `\n“${item.quote}”`
    } else if (item.category === 'example')
      row.body += `\n例：${item.title}${item.body && item.body !== item.title ? `——${item.body}` : ''}`
    else if (item.quote && item.quote !== row.quote) row.body += `\n“${item.quote}”`
    row.evidence = [...new Set([...row.evidence, ...item.evidence])].slice(0, 8)
    removed.add(item.id)
  }
  return merged.filter((item) => !removed.has(item.id))
}
export const SeriesInput = z.object({
  name: z.string().trim().min(1).max(100),
  scene: z.enum(['meeting', 'lecture', 'thought', 'unspecified']),
  categoryId: z.string().max(128).nullable().default(null)
})
export interface Series {
  id: string
  name: string
  scene: Scene
  categoryId: string | null
}
export interface SeriesDetail {
  series: Series
  sources: Source[]
  actions: ActionItem[]
}
export interface PersonPageData {
  person: Person | null
  sources: Source[]
  actions: ActionItem[]
  viewpoints: { derivationId: string; sourceId: string; title: string; item: LensItem; t: number }[]
}
export const RecordingFiltersSchema = z.object({
  personId: z.string().max(128).optional(),
  scene: z.enum(['meeting', 'lecture', 'thought', 'unspecified']).optional(),
  seriesId: z.string().max(128).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
})
export type RecordingFilters = z.infer<typeof RecordingFiltersSchema>
export function sceneNeedsChoice(scene: Scene, guess: SceneGuess | null): boolean {
  return scene === 'unspecified' && (!guess || guess.confidence < 0.75)
}
export function recordingMatches(
  meta: { personIds: string[]; scene: string; seriesId: string | null; startedAt: number; localOnly: boolean; deleted: boolean },
  filters: RecordingFilters
): boolean {
  const d = new Date(meta.startedAt),
    date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return (
    !meta.localOnly &&
    !meta.deleted &&
    (!filters.personId || meta.personIds.includes(filters.personId)) &&
    (!filters.scene || filters.scene === meta.scene) &&
    (!filters.seriesId || filters.seriesId === meta.seriesId) &&
    (!filters.from || date >= filters.from) &&
    (!filters.to || date <= filters.to)
  )
}
export function normalizeLensOutput(
  output: LensOutputId,
  raw: unknown
): { items: LensItem[]; dropped: LensDrop[]; course?: string; lecture?: string } {
  const result = LENS_SCHEMAS[output].parse(raw) as Record<string, unknown>,
    items: LensItem[] = [],
    dropped: LensDrop[] = []
  const categories: Record<string, LensCategory> = {
    topic: 'topic',
    agendas: 'agenda',
    decisions: 'decision',
    actions: 'action',
    questions: 'question',
    risks: 'risk',
    progress: 'progress',
    outline: 'outline',
    concepts: 'concept',
    examples: 'example',
    emphasis: 'emphasis',
    qa: 'qa',
    assignments: 'action',
    rows: 'row',
    paragraphs: 'paragraph',
    ideas: 'idea',
    plans: 'action',
    links: 'link',
    sentences: 'brief'
  }
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') continue
    const values = Array.isArray(value) ? value : [value]
    for (const [index, entry] of values.entries()) {
      const e = entry as z.infer<typeof LensEntrySchema> & { category?: LensCategory },
        id = `i${items.length + dropped.length + 1}`
      if (index >= 50) {
        dropped.push({ itemId: id, title: e.title, body: e.body, reason: 'limit' })
        continue
      }
      items.push({ ...e, id, category: e.category ?? categories[key] ?? 'item' })
    }
  }
  return {
    items,
    dropped,
    ...(typeof result.course === 'string' ? { course: result.course } : {}),
    ...(typeof result.lecture === 'string' ? { lecture: result.lecture } : {})
  }
}
export const lensParagraph = (body: string, suffix: DocNode[] = []): DocNode & { type: string } => ({
  type: 'paragraph',
  content: [...(body ? [{ type: 'text', text: body }] : []), ...suffix]
})
export const lensText = (item: LensItem): string => [item.title, item.body, item.quote].filter(Boolean).join('\n')
export function lensMarkdown(items: LensItem[], sentences: EvidenceSentence[], sourceId: string): string {
  return items
    .map(
      (item) =>
        `### ${item.title}\n\n${item.cue ? `${item.cue}\n\n` : ''}${item.body}${item.quote ? `\n\n> ${item.quote}` : ''}\n\n${item.evidence
          .map((ref) => sentences.find((s) => s.ref === ref))
          .filter((s): s is EvidenceSentence => !!s)
          .map(
            (s) =>
              `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}](${`jiwei://source/${encodeURIComponent(sourceId)}?t=${s.start}`})`
          )
          .join(' ')}${item.ownerName ? `\n\n${item.ownerName}` : ''}${item.dueDate ? ` · ${item.dueDate}` : ''}`
    )
    .join('\n\n')
}
