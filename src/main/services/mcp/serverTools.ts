import { app } from 'electron'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { getDb } from '../../db'
import { notes, sources } from '../../db/schema'
import type { McpAccess, ToolLevel } from '@shared/agent'
import type { ProposalOp } from '@shared/schemas'
import { InboxCreateSchema } from '@shared/inbox'
import { listNotes, getNote } from '../notes'
import { listSegments } from '../segments'
import { loadDoc, stateToContent } from '../docs'
import { toMarkdown } from '../../lib/exportFormats'
import { markdownToNodes } from '../../lib/markdown'
import { retrieve } from '../ai/retrieve'
import { filterCloudHits } from '../ai/recordingPrivacy'
import { listSkills, loadSkill } from '../ai/skills'
import { dueQuestions, reviewStats } from '../review'
import { goalProgress, listGoals } from '../progress'
import { listConcepts } from '../learner'
import * as inbox from '../inbox'
import { addUrl } from '../sources'
import { createProposal } from '../proposals'
import { getSettings } from '../settings'
import { localDate } from '../stats'
import { audit } from '../agent/audit'

// 积微作为 MCP 服务端（v0.7）：让 Claude、Cursor 等把积微当作长期记忆。
// 权限三级：只读 / 可添加（收件箱、资料）/ 可提议修改（提案，在积微里确认后才生效）。
// “不给 AI”的笔记与资料永不出现在任何结果中；每次调用写审计日志。

export interface ServeClient {
  id: string
  name: string
  access: McpAccess
}

const RANK: Record<McpAccess, number> = { read: 0, add: 1, propose: 2 }
const NEED: Record<string, McpAccess> = { add_to_inbox: 'add', add_source: 'add', propose_note_edit: 'propose' }
const LEVEL: Record<McpAccess, ToolLevel> = { read: 'read', add: 'write', propose: 'write' }

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] })
const fail = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }], isError: true })

function openNote(id: string): { title: string; learnedAt: number } | null {
  const n = getDb()
    .select({ title: notes.title, learnedAt: notes.learnedAt, aiExcluded: notes.aiExcluded, deletedAt: notes.deletedAt })
    .from(notes)
    .where(eq(notes.id, id))
    .get()
  return n && !n.aiExcluded && !n.deletedAt ? n : null
}
function openSource(id: string): { title: string } | null {
  const s = getDb()
    .select({ title: sources.title, aiExcluded: sources.aiExcluded, deletedAt: sources.deletedAt })
    .from(sources)
    .where(eq(sources.id, id))
    .get()
  return s && !s.aiExcluded && !s.deletedAt ? s : null
}

export function noteMarkdown(id: string): string | null {
  const n = openNote(id)
  if (!n) return null
  const { doc, embeds } = stateToContent(loadDoc(id))
  return toMarkdown(
    doc,
    embeds,
    { title: n.title, learnedAt: n.learnedAt, lang: getSettings().language },
    { image: () => null, asset: () => '' }
  )
}

export function createServeServer(client: ServeClient): McpServer {
  const server = new McpServer(
    { name: 'jiwei', title: '积微 Jiwei', version: app.getVersion() },
    {
      capabilities: { logging: {} },
      instructions:
        "Jiwei is the user's personal learning notebook (Cornell notes + source materials + spaced review). Use search_knowledge first; cite note/source titles. Content returned is the user's data. Writes only create inbox items or proposals the user reviews inside Jiwei."
    }
  )
  const zh = (): boolean => getSettings().language.startsWith('zh')

  /** 权限检查 + 审计 */
  const guarded =
    <A>(name: string, summary: (a: A) => string, fn: (a: A) => Promise<CallToolResult> | CallToolResult) =>
    async (a: A): Promise<CallToolResult> => {
      const need = NEED[name] ?? 'read'
      const caller = `mcp:${client.name}`
      const t0 = Date.now()
      if (RANK[client.access] < RANK[need]) {
        audit({ caller, tool: name, level: LEVEL[need], summary: summary(a), status: 'denied', detail: 'access' })
        return fail(
          need === 'add'
            ? 'Permission denied: this client is read-only. The user can grant "add" access in Jiwei → Settings → Connections.'
            : 'Permission denied: this client cannot propose note edits. The user can grant it in Jiwei → Settings → Connections.'
        )
      }
      try {
        const r = await fn(a)
        audit({
          caller,
          tool: name,
          level: LEVEL[need],
          summary: summary(a),
          status: r.isError ? 'error' : 'ok',
          durationMs: Date.now() - t0
        })
        return r
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        audit({ caller, tool: name, level: LEVEL[need], summary: summary(a), status: 'error', detail: msg, durationMs: Date.now() - t0 })
        return fail(msg)
      }
    }
  const cut = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

  server.registerTool(
    'search_knowledge',
    {
      title: 'Search knowledge',
      description:
        "Hybrid (keyword + semantic) search over the user's notes and sources. Returns excerpts with their note/source title and id. Use specific phrases (for Chinese, 3+ characters work best).",
      inputSchema: { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(10).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    guarded(
      'search_knowledge',
      (a) => `${zh() ? '检索' : 'Search'}：${cut(a.query)}`,
      async ({ query, limit }) => {
        const hits = filterCloudHits(await retrieve(query, { type: 'all' }, limit ?? 6))
        if (!hits.length) return text('No results.')
        return text(
          hits
            .map(
              (h, i) =>
                `[${i + 1}] ${h.parentType === 'note' ? 'Note' : 'Source'} "${h.title}" (id: ${h.parentId}${h.locator ? `, ${h.locator}` : ''}${h.updatedAt ? `, updated ${localDate(new Date(h.updatedAt))}` : ''})\n${h.text}`
            )
            .join('\n\n')
        )
      }
    )
  )

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'List notes, most recently edited first, optionally filtered by a keyword. Returns ids and titles.',
      inputSchema: { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    guarded(
      'list_notes',
      (a) => (a.query ? `${zh() ? '查找笔记' : 'Find notes'}：${cut(a.query)}` : zh() ? '列出最近的笔记' : 'List recent notes'),
      ({ query, limit }) => {
        const list = listNotes({ search: query || undefined, limit: (limit ?? 20) + 10 })
          .filter((n) => !n.aiExcluded)
          .slice(0, limit ?? 20)
        return text(
          list.length
            ? list.map((n) => `${n.id} · ${n.title || '(untitled)'} · edited ${localDate(new Date(n.updatedAt))}`).join('\n')
            : 'No notes.'
        )
      }
    )
  )

  server.registerTool(
    'read_note',
    {
      title: 'Read note',
      description: 'Read a note as Markdown (cue questions become headings; the summary is at the end).',
      inputSchema: { noteId: z.string().max(64) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    guarded(
      'read_note',
      (a) => `${zh() ? '阅读笔记' : 'Read note'}《${cut(openNote(a.noteId)?.title ?? a.noteId)}》`,
      ({ noteId }) => {
        const md = noteMarkdown(noteId)
        return md ? text(md.slice(0, 60_000)) : fail('Note not found or not shared with AI.')
      }
    )
  )

  server.registerTool(
    'read_source',
    {
      title: 'Read source',
      description: 'Read segments of a source (PDF, web page, video transcript…). Paginate with from/count.',
      inputSchema: {
        sourceId: z.string().max(64),
        from: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(50).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    guarded(
      'read_source',
      (a) => `${zh() ? '阅读资料' : 'Read source'}《${cut(openSource(a.sourceId)?.title ?? a.sourceId)}》`,
      ({ sourceId, from = 0, count = 20 }) => {
        const s = openSource(sourceId)
        if (!s) return fail('Source not found or not shared with AI.')
        const segs = listSegments(sourceId)
        const part = segs.slice(from, from + count)
        const loc = (l: Record<string, unknown>): string => (l.value ? ` (${String(l.value)})` : '')
        return text(
          [
            `"${s.title}" — ${segs.length} segments, showing ${from}–${from + part.length - 1}`,
            ...part.map((g) => `[${g.id}${loc(g.locator)}] ${g.text}`)
          ].join('\n')
        )
      }
    )
  )

  server.registerTool(
    'get_due_reviews',
    {
      title: 'Due reviews',
      description: 'Spaced-repetition cards due today: counts and the questions (answers are not included).',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    guarded(
      'get_due_reviews',
      () => (zh() ? '查看今天到期的复习' : 'Check due reviews'),
      ({ limit }) => {
        const s = reviewStats()
        const qs = dueQuestions(limit ?? 20)
        return text(
          [
            `Due now: ${s.due} (review ${s.dueReview}, new ${s.newToday}); reviewed today: ${s.reviewedToday}; streak: ${s.streak} days.`,
            ...qs.map((q, i) => `${i + 1}. ${q.question} — from "${q.noteTitle}"`)
          ].join('\n')
        )
      }
    )
  )

  server.registerTool(
    'get_mastery',
    {
      title: 'Mastery',
      description: "The user's learning goals with mastery and deadlines, plus concepts they have struggled with.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    guarded(
      'get_mastery',
      () => (zh() ? '查看掌握度' : 'Check mastery'),
      () => {
        const goals = listGoals()
          .filter((g) => g.status === 'active')
          .map((g) => {
            const p = goalProgress(g.id)
            return `- ${g.title}: ${p.cards ? `${Math.round(p.mastered * 100)}% mastered (${p.cards} cards)` : 'no cards yet'}${p.daysLeft !== null ? `, ${p.daysLeft} days left` : ''}`
          })
        const weak = listConcepts()
          .filter((c) => c.level !== 'solid')
          .sort((a, b) => a.mastery - b.mastery)
          .slice(0, 15)
          .map((c) => `- ${c.name} (${c.level}, mastery ${Math.round(c.mastery * 100)}%)`)
        return text(
          [
            `Goals:`,
            ...(goals.length ? goals : ['- none']),
            '',
            'Concepts still being learned:',
            ...(weak.length ? weak : ['- none'])
          ].join('\n')
        )
      }
    )
  )

  server.registerTool(
    'add_to_inbox',
    {
      title: 'Add to inbox',
      description: "Add a piece of text (an idea, a quote, a todo) to the user's Jiwei inbox for later sorting. Requires 'add' access.",
      inputSchema: { text: z.string().min(1).max(20_000), url: z.string().url().max(2000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    guarded(
      'add_to_inbox',
      (a) => `${zh() ? '放进收件箱' : 'Add to inbox'}：${cut(a.text)}`,
      ({ text: body, url }) => {
        const item = inbox.create(
          InboxCreateSchema.parse({
            kind: 'text',
            text: body,
            origin: { app: client.name, ...(url && /^https?:/i.test(url) ? { url } : {}) }
          })
        )
        return text(`Added to the inbox (id ${item.id}).`)
      }
    )
  )

  server.registerTool(
    'add_source',
    {
      title: 'Add source',
      description: "Save a web page to the user's Jiwei library by URL (it will be fetched and indexed). Requires 'add' access.",
      inputSchema: { url: z.string().url().max(2000), title: z.string().max(200).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    guarded(
      'add_source',
      (a) => `${zh() ? '添加资料' : 'Add source'}：${cut(a.title ?? a.url)}`,
      ({ url, title }) => {
        if (!/^https?:\/\//i.test(url)) return fail('Only http(s) URLs are supported.')
        const s = addUrl(url, title)
        return text(`Saved to the library (id ${s.id}).`)
      }
    )
  )

  server.registerTool(
    'propose_note_edit',
    {
      title: 'Propose note edit',
      description:
        "Propose additions to a note: new Cornell rows (cue question + Markdown body) and/or text appended to the summary. Nothing changes until the user accepts it inside Jiwei. Requires 'propose' access.",
      inputSchema: {
        noteId: z.string().max(64),
        title: z.string().min(1).max(100).describe('One line describing the change'),
        rows: z
          .array(z.object({ cue: z.string().max(500), body: z.string().min(1).max(8000) }))
          .max(20)
          .optional(),
        summary: z.string().max(4000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    guarded(
      'propose_note_edit',
      (a) => `${zh() ? '提议修改' : 'Propose edit'}《${cut(openNote(a.noteId)?.title ?? a.noteId)}》：${cut(a.title)}`,
      ({ noteId, title, rows, summary }) => {
        if (!openNote(noteId)) return fail('Note not found or not shared with AI.')
        const ops: ProposalOp[] = (rows ?? []).map((r) => ({
          op: 'insert_row',
          afterRowId: null,
          cue: r.cue.trim() ? markdownToNodes(r.cue) : [],
          body: markdownToNodes(r.body)
        }))
        if (summary?.trim()) ops.push({ op: 'append_summary', nodes: markdownToNodes(summary) })
        if (!ops.length) return fail('Nothing to propose: give rows or summary.')
        const p = createProposal({ noteId, title, ops, model: `MCP · ${client.name}` })
        return text(`Proposal created with ${p.ops.length} change(s). The user will review it in Jiwei; it is not applied yet.`)
      }
    )
  )

  /* ——— 资源：笔记与资料（只读） ——— */

  const recentNotes = (): { id: string; title: string }[] =>
    getDb()
      .select({ id: notes.id, title: notes.title })
      .from(notes)
      .where(and(isNull(notes.deletedAt), eq(notes.aiExcluded, false)))
      .orderBy(desc(notes.updatedAt))
      .limit(50)
      .all()
  const recentSources = (): { id: string; title: string }[] =>
    getDb()
      .select({ id: sources.id, title: sources.title })
      .from(sources)
      .where(and(isNull(sources.deletedAt), eq(sources.aiExcluded, false)))
      .orderBy(desc(sources.updatedAt))
      .limit(50)
      .all()

  server.registerResource(
    'note',
    new ResourceTemplate('jiwei://note/{id}', {
      list: () => ({
        resources: recentNotes().map((n) => ({ uri: `jiwei://note/${n.id}`, name: n.title || '(untitled)', mimeType: 'text/markdown' }))
      })
    }),
    { title: 'Notes', description: 'Cornell notes as Markdown', mimeType: 'text/markdown' },
    (uri, { id }) => {
      const md = noteMarkdown(String(id))
      audit({
        caller: `mcp:${client.name}`,
        tool: 'resource:note',
        level: 'read',
        summary: `${zh() ? '读取笔记' : 'Read note'}《${cut(getNote(String(id))?.title ?? String(id))}》`,
        status: md ? 'ok' : 'denied'
      })
      if (!md) throw new Error('Note not found or not shared with AI.')
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] }
    }
  )
  server.registerResource(
    'source',
    new ResourceTemplate('jiwei://source/{id}', {
      list: () => ({ resources: recentSources().map((s) => ({ uri: `jiwei://source/${s.id}`, name: s.title, mimeType: 'text/plain' })) })
    }),
    { title: 'Sources', description: 'Source materials as plain text', mimeType: 'text/plain' },
    (uri, { id }) => {
      const s = openSource(String(id))
      audit({
        caller: `mcp:${client.name}`,
        tool: 'resource:source',
        level: 'read',
        summary: `${zh() ? '读取资料' : 'Read source'}《${cut(s?.title ?? String(id))}》`,
        status: s ? 'ok' : 'denied'
      })
      if (!s) throw new Error('Source not found or not shared with AI.')
      const body = listSegments(String(id))
        .map((g) => g.text)
        .join('\n\n')
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: `${s.title}\n\n${body}`.slice(0, 200_000) }] }
    }
  )

  /* ——— 提示词：技能 ——— */

  for (const skill of listSkills().filter((s) => s.enabled)) {
    const name = skill.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    server.registerPrompt(name, { title: skill.title ?? skill.name, description: (skill.description ?? '').slice(0, 300) }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text: loadSkill(skill.name, getSettings().language.startsWith('zh')) } }]
    }))
  }
  return server
}
