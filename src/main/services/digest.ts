import { protectNoteAttachments, protectProposalAttachments } from './attachmentDerived'
import { tablePreview } from '../lib/attachmentText'
import { canReadSource, isConversationAttachment } from './attachmentsAccess'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { sources } from '../db/schema'
import { emit } from '../events'
import { markdownToNodes } from '../lib/markdown'
import type { ProposalOp, Segment } from '@shared/types'
import { formatMoney } from '@shared/money'
import { enqueue, registerJobKind, type JobContext } from './jobs'
import { listSegments } from './segments'
import { createNote } from './notes'
import { createProposal } from './proposals'
import { relate } from './connections'
import { getSettings } from './settings'
import { quickModel, structured } from './ai/structured'
import { buildMindmap, NestedSchema } from './ai/tools'
import { costOf } from './agent/pricing'

// 整份资料（或一个页码范围）的思维导图 / 总结 / 康奈尔提纲（v0.7.6）。
// 几百页的资料放不进一次对话：先分批读取、逐批提炼要点（快速模型），再汇总成结果（对话模型），
// 最后作为提案放进笔记，由用户确认。开始前在对话里给出预计费用、请用户确认。

export type DigestTask = 'mindmap' | 'summary' | 'outline'
export interface DigestInput {
  conversationId?: string | null
  sourceId: string
  task: DigestTask
  fromPage?: number
  toPage?: number
  /** 放进哪篇笔记；不填则新建一篇并关联资料 */
  noteId?: string | null
  providerId: string
  model: string
}

const CHUNK = 9000
const JOB = 'source.digest'

const pageOf = (s: Segment): number | null => {
  const m = /page=(\d+)/.exec(String((s.locator as { value?: unknown }).value ?? ''))
  return m ? Number(m[1]) : null
}

/** 资料的规模与章节线索（给模型判断范围用） */
export function sourceSize(sourceId: string): { segments: number; chars: number; pages: number | null } {
  const segs = listSegments(sourceId)
  const pages = segs.reduce((m, s) => Math.max(m, pageOf(s) ?? 0), 0)
  return { segments: segs.length, chars: segs.reduce((n, s) => n + s.text.length, 0), pages: pages || null }
}

const HEADING = /^(第[一二三四五六七八九十百零〇\d]+[章节部篇讲回]|chapter\s+\d+|part\s+[ivx\d]+|\d+(\.\d+){0,2}\s+\S)/i

/** 章节目录：分段时识别出的标题，没有时按“第 X 章 / 1.2 标题”之类的短行猜测 */
export function sourceOutline(sourceId: string): { title: string; page: number | null; ordinal: number }[] {
  const segs = listSegments(sourceId)
  const structured = segs.filter((s, i) => s.heading && s.heading !== segs[i - 1]?.heading).slice(0, 120)
  if (structured.length) return structured.map((s) => ({ title: s.heading!, page: pageOf(s), ordinal: s.ordinal }))
  const marked = segs.filter((s) => s.kind === 'heading')
  const pick = (marked.length >= 3 ? marked : segs.filter((s) => s.text.length <= 60 && HEADING.test(s.text.trim()))).slice(0, 120)
  return pick.map((s) => ({
    title: s.text
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 60),
    page: pageOf(s),
    ordinal: s.ordinal
  }))
}

function rangeOf(input: Pick<DigestInput, 'sourceId' | 'fromPage' | 'toPage' | 'conversationId'>): Segment[] {
  const source = getDb().select({ space: sources.space }).from(sources).where(eq(sources.id, input.sourceId)).get()
  const all = listSegments(input.sourceId)
  const segs = (
    source?.space === 'attachment' || isConversationAttachment(input.sourceId, input.conversationId ?? null) ? tablePreview(all) : all
  ).filter((s) => s.text.trim() && s.kind !== 'code')
  if (input.fromPage == null && input.toPage == null) return segs
  const from = input.fromPage ?? 1
  const to = input.toPage ?? Number.MAX_SAFE_INTEGER
  return segs.filter((s) => {
    const p = pageOf(s)
    return p !== null && p >= from && p <= to
  })
}

function chunks(segs: Segment[]): { ids: string[]; text: string }[] {
  const out: { ids: string[]; text: string }[] = []
  let cur: { ids: string[]; text: string } = { ids: [], text: '' }
  for (const s of segs) {
    const line = `[${s.id}${pageOf(s) ? ` p.${pageOf(s)}` : ''}] ${s.text.trim()}\n`
    if (cur.text.length + line.length > CHUNK && cur.text) {
      out.push(cur)
      cur = { ids: [], text: '' }
    }
    cur.ids.push(s.id)
    cur.text += line
  }
  if (cur.text) out.push(cur)
  return out
}

/** 预计规模与费用（美元；价格未知时为 null） */
export function estimateDigest(input: DigestInput): {
  segments: number
  batches: number
  pages: [number, number] | null
  cost: number | null
} {
  const segs = rangeOf(input)
  const parts = chunks(segs)
  const chars = segs.reduce((n, s) => n + s.text.length, 0)
  const map = costOf(input.providerId, quickModel(input.providerId, input.model), {
    inputTokens: Math.ceil(chars / 1.5) + parts.length * 900,
    outputTokens: parts.length * 700,
    reasoningTokens: 0,
    cachedInputTokens: 0
  }).cost
  const reduce = costOf(input.providerId, input.model, {
    inputTokens: parts.length * 700 + 2000,
    outputTokens: 3000,
    reasoningTokens: 0,
    cachedInputTokens: 0
  }).cost
  const pages = segs.map(pageOf).filter((p): p is number => p !== null)
  return {
    segments: segs.length,
    batches: parts.length,
    pages: pages.length ? [Math.min(...pages), Math.max(...pages)] : null,
    cost: map === null || reduce === null ? null : map + reduce
  }
}

const TASK_ZH: Record<DigestTask, string> = { mindmap: '思维导图', summary: '总结', outline: '康奈尔提纲' }
const TASK_EN: Record<DigestTask, string> = { mindmap: 'mind map', summary: 'summary', outline: 'Cornell outline' }

/** 确认卡片上的一句话与费用说明 */
export function describeDigest(input: DigestInput, zh: boolean): { title: string; detail: string } {
  const title = getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, input.sourceId)).get()?.title ?? ''
  const e = estimateDigest(input)
  const range = e.pages
    ? zh
      ? `第 ${e.pages[0]}–${e.pages[1]} 页`
      : `pages ${e.pages[0]}–${e.pages[1]}`
    : zh
      ? '整份资料'
      : 'the whole source'
  const s = getSettings()
  const cost = e.cost === null ? (zh ? '价格未知' : 'unknown') : `≈ ${formatMoney(e.cost, s.money, s.language)}`
  return zh
    ? {
        title: `把《${title}》${range}整理成${TASK_ZH[input.task]}`,
        detail: `共 ${e.segments} 段，分 ${e.batches} 批读取；预计费用 ${cost}（以实际为准）。在后台进行，完成后作为提案放进笔记，由你确认。`
      }
    : {
        title: `Turn ${range} of "${title}" into a ${TASK_EN[input.task]}`,
        detail: `${e.segments} segments in ${e.batches} batches; estimated cost ${cost}. Runs in the background and arrives as a proposal in a note for you to confirm.`
      }
}

export function startDigest(input: DigestInput): { jobId: string; noteId: string } {
  const src = getDb().select().from(sources).where(eq(sources.id, input.sourceId)).get()
  if (!src || src.deletedAt) throw new Error('Source not found')
  if (!canReadSource(input.sourceId, input.conversationId ?? null)) throw new Error('This source is excluded from AI')
  if (!rangeOf(input).length) throw new Error(getSettings().language.startsWith('zh') ? '这个范围里没有文字内容' : 'No text in this range')
  const noteId = getDb().transaction(() => {
    let id = input.noteId ?? null
    if (!id) {
      const zh = getSettings().language.startsWith('zh')
      id = createNote({
        title: zh ? `《${src.title}》${TASK_ZH[input.task]}` : `${src.title} — ${TASK_EN[input.task]}`
      }).id
      relate(id, 'source', input.sourceId)
    }
    if (src.space === 'attachment') protectNoteAttachments(id, [src.id])
    return id
  })
  const jobId = enqueue(JOB, { ...input, noteId })
  return { jobId, noteId }
}

const PointsSchema = z.object({
  topic: z.string().max(60).describe('这一批内容的主题（不超过 20 字）'),
  points: z
    .array(z.object({ text: z.string().min(1).max(120), segmentId: z.string().max(64) }))
    .min(1)
    .max(14)
})
type Points = z.infer<typeof PointsSchema>

async function run(input: DigestInput & { noteId: string }, ctx: JobContext): Promise<{ noteId: string }> {
  const zh = getSettings().language.startsWith('zh')
  const src = getDb().select().from(sources).where(eq(sources.id, input.sourceId)).get()
  if (!src || !canReadSource(input.sourceId, input.conversationId ?? null)) throw new Error('Source unavailable')
  if (src.space === 'attachment') protectNoteAttachments(input.noteId, [src.id])
  const parts = chunks(rangeOf(input))
  const quick = quickModel(input.providerId, input.model)
  const mapped: Points[] = []
  // 1. 逐批提炼要点（带片段 ID，结果里的节点可以回到原文）
  for (const [i, part] of parts.entries()) {
    if (!canReadSource(input.sourceId, input.conversationId ?? null)) throw new Error('Source access revoked')
    if (ctx.isCanceled()) throw new Error('canceled')
    mapped.push(
      await structured({
        guard: () => {
          if (!canReadSource(input.sourceId, input.conversationId ?? null)) throw new Error('Source access revoked')
        },
        purpose: 'digest',
        providerId: input.providerId,
        model: quick,
        system: zh
          ? '你在帮用户通读一份长资料。下面是其中连续的一段，每行开头的方括号是片段 ID 与页码。提炼这一段最重要的要点（5～12 条，每条一句话，不超过 40 字），每条注明出自哪个片段 ID。只写原文里有的内容。'
          : 'You are reading a long source with the user. Below is one consecutive part; each line starts with [segment ID page]. Extract the 5–12 most important points (one sentence each) and cite the segment ID for each. Only use what the text says.',
        prompt: part.text,
        schema: PointsSchema
      })
    )
    ctx.progress(((i + 1) / (parts.length + 1)) * 0.9)
  }
  const digest = mapped
    .map((m, i) => `## ${i + 1}. ${m.topic}\n${m.points.map((p) => `- ${p.text} {${p.segmentId}}`).join('\n')}`)
    .join('\n\n')
  const valid = new Set(parts.flatMap((p) => p.ids))
  const segs = (ids: (string | undefined)[]): string[] => ids.filter((id): id is string => !!id && valid.has(id))
  let ops: ProposalOp[]
  let embeds: Record<string, { kind: string; data: unknown }> | undefined
  let cited: string[]
  const range =
    input.fromPage != null || input.toPage != null
      ? zh
        ? `第 ${input.fromPage ?? 1}–${input.toPage ?? '末'} 页`
        : `pp. ${input.fromPage ?? 1}–${input.toPage ?? 'end'}`
      : ''
  // 2. 汇总
  if (input.task === 'mindmap') {
    const { tree } = await structured({
      guard: () => {
        if (!canReadSource(input.sourceId, input.conversationId ?? null)) throw new Error('Source access revoked')
      },
      purpose: 'digest',
      providerId: input.providerId,
      model: input.model,
      system: zh
        ? '根据各部分要点，为整份资料画一张思维导图：根节点是资料主题（不超过 12 字）；第一层 4～8 个分支，按同一维度划分（通常是章节或主题），互不重叠；2～3 层，总节点 20～45 个；节点是关键词或短语（不超过 15 字）。节点来自某条要点时，把花括号里的片段 ID 填到 segmentId。'
        : 'From the part summaries, draw a mind map of the whole source: root = topic; 4–8 first-level branches along one dimension; 2–3 levels, 20–45 nodes; short phrases. Put the segment ID from braces into segmentId when a node comes from a point.',
      prompt: `《${src.title}》${range}\n\n${digest}`,
      schema: z.object({ tree: NestedSchema })
    })
    const { data, segs: used } = buildMindmap(tree)
    cited = segs(used)
    embeds = { mm: { kind: 'mindmap', data } }
    ops = [
      {
        op: 'insert_row',
        afterRowId: null,
        cue: markdownToNodes(
          zh ? `《${src.title}》${range}的整体结构是什么？` : `What is the structure of "${src.title}"${range ? ` (${range})` : ''}?`
        ),
        body: [{ type: 'embed', attrs: { id: 'mm', kind: 'mindmap' } }]
      }
    ]
  } else if (input.task === 'summary') {
    const r = await structured({
      guard: () => {
        if (!canReadSource(input.sourceId, input.conversationId ?? null)) throw new Error('Source access revoked')
      },
      purpose: 'digest',
      providerId: input.providerId,
      model: input.model,
      system: zh
        ? '根据各部分要点，写整份资料的总结：先用 2～3 句话说清主题与核心结论，再按结构分 3～7 个小标题，每个小标题下 2～4 条要点。总长 500～1200 字，Markdown。'
        : 'From the part summaries, summarize the whole source: 2–3 sentences on the topic and main conclusions, then 3–7 headed sections with 2–4 points each. 400–900 words, Markdown.',
      prompt: `《${src.title}》${range}\n\n${digest}`,
      schema: z.object({ markdown: z.string().min(50).max(8000) })
    })
    cited = segs(mapped.flatMap((m) => m.points.map((p) => p.segmentId)))
    ops = [
      {
        op: 'insert_row',
        afterRowId: null,
        cue: markdownToNodes(zh ? `《${src.title}》${range}讲了什么？` : `What does "${src.title}" cover?`),
        body: markdownToNodes(r.markdown)
      }
    ]
  } else {
    const r = await structured({
      guard: () => {
        if (!canReadSource(input.sourceId, input.conversationId ?? null)) throw new Error('Source access revoked')
      },
      purpose: 'digest',
      providerId: input.providerId,
      model: input.model,
      system: zh
        ? '根据各部分要点，为整份资料起草康奈尔笔记提纲：6～16 行，每行的线索是一个复习问题（不超过 25 字，优先问为什么 / 怎么做 / 有什么区别），笔记是 2～5 条要点（Markdown 列表），并列出这一行依据的片段 ID。'
        : 'From the part summaries, draft a Cornell outline: 6–16 rows; cue = a review question; body = 2–5 bullet points (Markdown); list the segment IDs used.',
      prompt: `《${src.title}》${range}\n\n${digest}`,
      schema: z.object({
        rows: z
          .array(
            z.object({
              cue: z.string().min(1).max(200),
              body: z.string().min(1).max(2000),
              segmentIds: z.array(z.string().max(64)).max(12)
            })
          )
          .min(1)
          .max(24)
      })
    })
    cited = segs(r.rows.flatMap((row) => row.segmentIds))
    ops = r.rows.map((row) => ({
      op: 'insert_row' as const,
      afterRowId: null,
      cue: markdownToNodes(row.cue),
      body: markdownToNodes(row.body)
    }))
  }
  if (ctx.isCanceled()) throw new Error('canceled')
  const proposal = createProposal({
    noteId: input.noteId,
    conversationId: input.conversationId,
    title: zh ? `${TASK_ZH[input.task]}：《${src.title}》${range}` : `${TASK_EN[input.task]}: ${src.title}`,
    ops,
    model: input.model,
    embeds,
    sources: cited.length ? [...new Set(cited)].map((id) => ({ type: 'segment' as const, id })) : undefined
  })
  protectProposalAttachments(proposal.id, [input.sourceId])
  emit('digest:done', { noteId: input.noteId, title: src.title, task: input.task })
  return { noteId: input.noteId }
}

export function registerDigestJob(): void {
  registerJobKind<DigestInput & { noteId: string }>(JOB, {
    title: (p) => {
      const src = getDb().select({ title: sources.title, space: sources.space }).from(sources).where(eq(sources.id, p.sourceId)).get()
      const title =
        src?.space === 'attachment' ? (getSettings().language.startsWith('zh') ? '对话附件' : 'chat attachment') : (src?.title ?? '')
      return getSettings().language.startsWith('zh') ? `整理《${title}》为${TASK_ZH[p.task]}` : `${TASK_EN[p.task]} of ${title}`
    },
    run
  })
}
