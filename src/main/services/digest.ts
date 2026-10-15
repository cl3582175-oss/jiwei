import { createHash } from 'node:crypto'
import { canUseNote } from './notePrivacy'
import { createModelRequest } from './ai/request'
import { parsePointLines, normalizeMindmap, normalizeOutline, DigestTreeSchema, DigestOutlineSchema, type Points } from './digestFormat'
import { notePrivacyEn, notePrivacyZh } from '../../renderer/src/features/notes/notePrivacyMessages'
import { protectNoteAttachments, protectProposalAttachments } from './attachmentDerived'
import { tablePreview } from '../lib/attachmentText'
import { canReadSource, isConversationAttachment } from './attachmentsAccess'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, getSqlite } from '../db'
import { jobs, sources } from '../db/schema'
import { emit } from '../events'
import { markdownToNodes } from '../lib/markdown'
import type { ProposalOp, Segment } from '@shared/types'
import { formatMoney } from '@shared/money'
import {
  enqueue,
  JobDeferred,
  patchQueuedPayload,
  registerJobKind,
  runJobNow,
  PermanentJobError,
  TemporaryJobError,
  type JobContext
} from './jobs'
import {
  applyRecognized,
  digestWaiting,
  ensureRecognition,
  pendingRecognition,
  recognitionEndedSince,
  sourceParsing,
  sourceRecognition,
  unrecognizedPages
} from './recognize'
import { listSegments } from './segments'
import { createNote, getNote } from './notes'
import { createProposal } from './proposals'
import { relate } from './connections'
import { getSettings } from './settings'
import { quickModel, structured } from './ai/structured'
import { buildMindmap } from './ai/tools'
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
const PROMPT_VERSION = 'digest-v2'
interface DigestJobInput extends DigestInput {
  noteId: string
  redirectedFrom?: string
  noWait?: true
}
const stepKey = (model: string, data: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([PROMPT_VERSION, model, data]))
    .digest('hex')

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
  const pages =
    input.fromPage !== undefined || input.toPage !== undefined ? [input.fromPage ?? 1, input.toPage ?? (zh ? '末' : 'end')] : e.pages
  const range = pages ? (zh ? `第 ${pages[0]}–${pages[1]} 页` : `pages ${pages[0]}–${pages[1]}`) : zh ? '整份资料' : 'the whole source'
  const s = getSettings()
  const cost = e.cost === null ? (zh ? '价格未知' : 'unknown') : `≈ ${formatMoney(e.cost, s.money, s.language)}`
  const redirect =
    input.noteId && !canUseNote(input.noteId, input.conversationId ?? null) ? (zh ? notePrivacyZh : notePrivacyEn).digestTargetRedirect : ''
  const unavailable = sourceRecognition(input.sourceId).engine !== 'ready'
  const pending = unavailable
    ? unrecognizedPages(input.sourceId, input.fromPage, input.toPage, 'pending').length
    : pendingRecognition(input.sourceId, input.fromPage, input.toPage).pending.length
  const recognition = !pending
    ? ''
    : unavailable
      ? zh
        ? `其中 ${pending} 页是图片或扫描页，当前没有可用的识别，整理会缺这些页。`
        : `${pending} pages are images or scans; recognition is currently unavailable, so these pages will be missing from the digest.`
      : zh
        ? `其中 ${pending} 页是图片或扫描页，会先识别再整理；识别后内容会变多，费用以实际为准。`
        : `${pending} pages are images or scans and will be recognized first; the cost may be higher once their text is added.`
  return zh
    ? {
        title: `把《${title}》${range}整理成${TASK_ZH[input.task]}`,
        detail: `共 ${e.segments} 段，分 ${e.batches} 批读取；预计费用 ${cost}（以实际为准）。在后台进行，完成后作为提案放进笔记，由你确认。${redirect ? ` ${redirect}` : ''}${recognition ? ` ${recognition}` : ''}`
      }
    : {
        title: `Turn ${range} of "${title}" into a ${TASK_EN[input.task]}`,
        detail: `${e.segments} segments in ${e.batches} batches; estimated cost ${cost}. Runs in the background and arrives as a proposal in a note for you to confirm.${redirect ? ` ${redirect}` : ''}${recognition ? ` ${recognition}` : ''}`
      }
}

function validate(input: DigestInput): void {
  if (
    !input.sourceId ||
    !input.providerId ||
    !input.model ||
    !['mindmap', 'summary', 'outline'].includes(input.task) ||
    (input.fromPage != null && (!Number.isInteger(input.fromPage) || input.fromPage < 1)) ||
    (input.toPage != null && (!Number.isInteger(input.toPage) || input.toPage < (input.fromPage ?? 1)))
  )
    throw new PermanentJobError('Invalid digest parameters')
}

function newDigestNote(input: DigestInput, src: { id: string; title: string; space: string }): string {
  const zh = getSettings().language.startsWith('zh')
  const id = createNote({ title: zh ? `《${src.title}》${TASK_ZH[input.task]}` : `${src.title} — ${TASK_EN[input.task]}` }).id
  relate(id, 'source', input.sourceId)
  if (src.space === 'attachment') protectNoteAttachments(id, [src.id])
  return id
}

export function startDigest(input: DigestInput): { jobId: string; noteId: string } {
  validate(input)
  const src = getDb().select().from(sources).where(eq(sources.id, input.sourceId)).get()
  if (!src || src.deletedAt) throw new PermanentJobError('Source not found')
  if (!canReadSource(input.sourceId, input.conversationId ?? null)) throw new PermanentJobError('This source is excluded from AI')
  if (!rangeOf(input).length && !digestWaiting(input))
    throw new PermanentJobError(getSettings().language.startsWith('zh') ? '这个范围里没有文字内容' : 'No text in this range')
  const noteId = getDb().transaction(() => {
    const id = input.noteId && canUseNote(input.noteId, input.conversationId ?? null) ? input.noteId : newDigestNote(input, src)
    if (src.space === 'attachment') protectNoteAttachments(id, [src.id])
    return id
  })
  const redirectedFrom = input.noteId && input.noteId !== noteId ? input.noteId : undefined
  const jobId = enqueue(JOB, { ...input, noteId, ...(redirectedFrom ? { redirectedFrom } : {}) })
  if (digestWaiting(input)) ensureRecognition(input.sourceId)
  return { jobId, noteId }
}

export function digestNow(jobId: string): void {
  const row = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get()
  if (row?.kind !== JOB || !patchQueuedPayload(jobId, { noWait: true })) return
  runJobNow(jobId)
}

/** 确认整理后识别被取消或失败结束：用已有内容整理（缺页写进提案），不再替用户重新排识别。 */
function recognitionAbandoned(input: DigestJobInput, ctx: JobContext): boolean {
  if (!ctx.jobId) return false
  const createdAt = getDb().select({ createdAt: jobs.createdAt }).from(jobs).where(eq(jobs.id, ctx.jobId)).get()?.createdAt
  return createdAt !== undefined && !sourceParsing(input.sourceId) && recognitionEndedSince(input.sourceId, createdAt)
}

function guardDigest(input: DigestJobInput, ctx: JobContext): void {
  if (ctx.isCanceled() || ctx.signal?.aborted) throw ctx.signal?.reason ?? new Error('canceled')
  if (!canReadSource(input.sourceId, input.conversationId ?? null)) throw new PermanentJobError('Source access revoked')
}

function run(input: DigestJobInput, ctx: JobContext): Promise<{ noteId: string }> {
  validate(input)
  guardDigest(input, ctx)
  // 同步退回 queued：同一次 tick 启动的识别也必须能看到这份整理的等待范围。
  if (digestWaiting(input) && !recognitionAbandoned(input, ctx)) {
    ensureRecognition(input.sourceId)
    throw new JobDeferred(60_000, 'waiting')
  }
  return digestSource(input, ctx)
}

async function digestSource(input: DigestJobInput, ctx: JobContext): Promise<{ noteId: string }> {
  const guard = (): void => guardDigest(input, ctx)
  guard()
  const zh = getSettings().language.startsWith('zh')
  const src = getDb().select().from(sources).where(eq(sources.id, input.sourceId)).get()!
  if (src.space === 'attachment') protectNoteAttachments(input.noteId, [src.id])
  applyRecognized(input.sourceId)
  const parts = chunks(rangeOf(input))
  const missing = unrecognizedPages(input.sourceId, input.fromPage, input.toPage)
  if (!parts.length) throw new PermanentJobError('No text in this range')
  const quick = quickModel(input.providerId, input.model)
  const keys = parts.map((part) => stepKey(quick, ['map', zh, part.ids, part.text]))
  const mapped: Points[] = []
  const request = (model: string, system: string, prompt: string) => ({
    guard,
    purpose: 'digest',
    providerId: input.providerId,
    model,
    system,
    prompt,
    signal: ctx.signal,
    sensitive: true
  })
  for (const [i, part] of parts.entries()) {
    guard()
    mapped.push(
      await ctx.step(keys[i], input.sourceId, async () => {
        const r = await createModelRequest(
          request(
            quick,
            zh
              ? '你在帮用户通读一份长资料。每行方括号是片段 ID 与页码。只提炼原文中的核心内容。第一行写 # 主题，之后每行写 - 要点 {片段ID}。写 5～12 条，每条一句、不超过 60 字。不要 JSON，不要解释格式。'
              : 'Read this consecutive part of a long source. Each line starts with [segment ID page]. Use only supplied facts. The first line is # Topic, then one - point {segmentID} per line. Give 5–12 points, at most 60 characters each. No JSON or format commentary.',
            part.text
          )
        ).generate('text')
        guard()
        const points = parsePointLines(r.text, new Set(part.ids))
        if (!points.points.length) throw new TemporaryJobError('Empty digest points')
        return points
      })
    )
    ctx.progress(Math.min(0.95, (i + 1) / (parts.length + 1)))
  }
  const digest = mapped
    .map((m, i) => `## ${i + 1}. ${m.topic}\n${m.points.map((p) => `- ${p.text}${p.segmentId ? ` {${p.segmentId}}` : ''}`).join('\n')}`)
    .join('\n\n')
  const valid = new Set(parts.flatMap((p) => p.ids))
  const segs = (ids: (string | undefined)[]): string[] => [...new Set(ids.filter((id): id is string => !!id && valid.has(id)))]
  const range =
    input.fromPage != null || input.toPage != null
      ? zh
        ? `第 ${input.fromPage ?? 1}–${input.toPage ?? '末'} 页`
        : `pp. ${input.fromPage ?? 1}–${input.toPage ?? 'end'}`
      : ''
  const prompt = `《${src.title}》${range}\n\n${digest}`
  const reduceKey = stepKey(input.model, ['reduce', input.task, zh, keys, prompt])
  const result = await ctx.step(reduceKey, input.sourceId, async () => {
    guard()
    let ops: ProposalOp[]
    let embeds: Record<string, { kind: string; data: unknown }> | undefined
    let cited: string[]
    if (input.task === 'mindmap') {
      const r = await structured({
        ...request(
          input.model,
          zh
            ? '根据各部分要点画整份资料的思维导图。根节点不超过12字，第一层4～8个分支，2～3层、20～45节点，节点不超过15字。引用要点时填写对应 segmentId。'
            : 'Draw a mind map from the part summaries: root topic, 4–8 branches, 2–3 levels, 20–45 short nodes. Cite segmentId for sourced nodes.',
          prompt
        ),
        schema: z.object({ tree: DigestTreeSchema })
      })
      const { data, segs: used } = buildMindmap(normalizeMindmap(r.tree, valid))
      cited = segs(used)
      embeds = { mm: { kind: 'mindmap', data } }
      ops = [
        {
          op: 'insert_row',
          afterRowId: null,
          cue: markdownToNodes(zh ? `《${src.title}》${range}的整体结构是什么？` : `What is the structure of "${src.title}"?`),
          body: [{ type: 'embed', attrs: { id: 'mm', kind: 'mindmap' } }]
        }
      ]
    } else if (input.task === 'summary') {
      const r = await createModelRequest(
        request(
          input.model,
          zh
            ? '根据各部分要点写整份资料的总结：先用2～3句话说清主题与核心结论，再按结构分3～7个小标题，每个小标题下2～4条要点。总长500～1200字。直接输出Markdown正文，不要JSON、不要工具调用。'
            : 'Summarize the whole source from these part summaries: 2–3 sentences for the main conclusions, 3–7 headed sections with 2–4 points each, 400–900 words. Output Markdown directly, no JSON or tool calls.',
          prompt
        )
      ).generate('text')
      if (!r.text.trim()) throw new TemporaryJobError('Empty digest summary')
      cited = segs(mapped.flatMap((m) => m.points.map((p) => p.segmentId)))
      ops = [
        {
          op: 'insert_row',
          afterRowId: null,
          cue: markdownToNodes(zh ? `《${src.title}》${range}讲了什么？` : `What does "${src.title}" cover?`),
          body: markdownToNodes(r.text)
        }
      ]
    } else {
      const r = await structured({
        ...request(
          input.model,
          zh
            ? '根据各部分要点起草整份资料的康奈尔笔记提纲：6～16行，每行线索是复习问题，笔记是2～5条Markdown要点，并列出依据的片段ID。'
            : 'Draft a Cornell outline from the summaries: 6–16 rows, review questions as cues, 2–5 Markdown points each, and supporting segment IDs.',
          prompt
        ),
        schema: DigestOutlineSchema
      })
      const rows = normalizeOutline(r.rows, valid)
      if (!rows.length) throw new TemporaryJobError('Empty digest outline')
      cited = segs(rows.flatMap((row) => row.segmentIds))
      ops = rows.map((row) => ({
        op: 'insert_row' as const,
        afterRowId: null,
        cue: markdownToNodes(row.cue),
        body: markdownToNodes(row.body)
      }))
    }
    guard()
    return { ops, embeds, cited }
  })
  ctx.progress(0.95)
  guard()
  let noteId = input.noteId
  const deliveryKey = stepKey(input.model, ['saved', reduceKey])
  getDb().transaction(() => {
    guard()
    const saved = ctx.jobId
      ? (getSqlite()
          .prepare(
            `SELECT s.output FROM job_steps s JOIN proposals p ON p.id=json_extract(s.output,'$.proposalId')
       JOIN notes n ON n.id=p.note_id WHERE s.job_id=? AND s.step_key=? AND n.deleted_at IS NULL`
          )
          .get(ctx.jobId, deliveryKey) as { output: string } | undefined)
      : undefined
    if (saved) {
      noteId = (JSON.parse(saved.output) as { noteId: string }).noteId
      return
    }
    if (!canUseNote(noteId, input.conversationId ?? null)) {
      try {
        noteId = newDigestNote(input, src)
      } catch {
        throw new PermanentJobError('Cannot create digest result note')
      }
    }
    const proposal = createProposal({
      noteId,
      conversationId: input.conversationId,
      title: zh ? `${TASK_ZH[input.task]}：《${src.title}》${range}` : `${TASK_EN[input.task]}: ${src.title}`,
      ops: (() => {
        if (!missing.length) return result.ops
        const pages = missing.slice(0, 10).join(zh ? '、' : ', ')
        const warning = zh
          ? `第 ${pages}${missing.length > 10 ? ` 等 ${missing.length}` : ''} 页未能识别，未纳入整理。`
          : `Pages ${pages}${missing.length > 10 ? ` and others (${missing.length} pages total)` : ''} could not be recognized and were not included in the digest.`
        return result.ops.map((op, i) =>
          op.op === 'insert_row' && i === result.ops.length - 1 ? { ...op, body: [...op.body, ...markdownToNodes(`- ${warning}`)] } : op
        )
      })(),
      model: input.model,
      embeds: result.embeds,
      sources: result.cited.length ? result.cited.map((id) => ({ type: 'segment' as const, id })) : undefined
    })
    protectProposalAttachments(proposal.id, [input.sourceId])
    if (ctx.jobId)
      getSqlite()
        .prepare(
          `INSERT INTO job_steps(job_id,step_key,source_id,output,created_at) VALUES(?,?,?,?,?)
       ON CONFLICT(job_id,step_key) DO UPDATE SET output=excluded.output,created_at=excluded.created_at`
        )
        .run(ctx.jobId, deliveryKey, input.sourceId, JSON.stringify({ noteId, proposalId: proposal.id }), Date.now())
  })
  const redirectedFrom = noteId !== input.noteId ? input.noteId : input.redirectedFrom
  emit('digest:done', {
    noteId,
    title: src.title,
    task: input.task,
    ...(redirectedFrom ? { redirectedFrom, noteTitle: getNote(noteId)?.title ?? '' } : {})
  })
  ctx.progress(1)
  return { noteId }
}

export function registerDigestJob(): void {
  registerJobKind<DigestJobInput>(JOB, {
    lane: 'user',
    waiting: digestWaiting,
    title: (p) => {
      const src = getDb().select({ title: sources.title, space: sources.space }).from(sources).where(eq(sources.id, p.sourceId)).get()
      const title =
        src?.space === 'attachment' ? (getSettings().language.startsWith('zh') ? '对话附件' : 'chat attachment') : (src?.title ?? '')
      return getSettings().language.startsWith('zh') ? `整理《${title}》为${TASK_ZH[p.task]}` : `${TASK_EN[p.task]} of ${title}`
    },
    run
  })
}
