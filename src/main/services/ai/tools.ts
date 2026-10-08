import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { notes, sources } from '../../db/schema'
import { listNotes } from '../notes'
import { listSegments } from '../segments'
import { loadDoc, stateToContent } from '../docs'
import { createProposal } from '../proposals'
import { nodeText } from '../../lib/derive'
import { markdownToNodes } from '../../lib/markdown'
import { fromNested, type NestedNode } from '@shared/embeds/mindmap'
import { newId } from '../../lib/ids'
import { loadSkill, readSkillFile } from './skills'
import { retrieve } from './retrieve'
import { saveMemory, searchMemories } from '../memory'
import type { ChatScope, ProposalOp } from '@shared/schemas'
import type { AgentStep, DocNode, SearchHit } from '@shared/types'

// AI 可用的工具（精选、参数简单）：
//   - 读：知识库检索、读笔记结构、读资料片段、找笔记；
//   - 写：一律生成“提案”，用户逐条确认后才生效；内容用 Markdown / 嵌套结构表达，由程序转换为正确的文档节点；
//   - 技能：按需加载流程；记忆：记住 / 回忆。
// 参数越简单，能力一般的模型越不容易出错，工具描述也越省 token。

export interface AgentSession {
  zh: boolean
  model: string
  scope: ChatScope
  incognito: boolean
  conversationId: string
  messageId: string
  /** 本轮回答中出现过的知识库片段（编号 = 下标 + 1） */
  hits: SearchHit[]
  /** 本轮加载过的技能 */
  skills: string[]
}

type NoteCheck = { title: string } | null
function readableNote(id: string): NoteCheck {
  const n = getDb()
    .select({ title: notes.title, aiExcluded: notes.aiExcluded, deletedAt: notes.deletedAt })
    .from(notes)
    .where(eq(notes.id, id))
    .get()
  return n && !n.aiExcluded && !n.deletedAt ? { title: n.title } : null
}
function readableSource(id: string): { title: string } | null {
  const s = getDb()
    .select({ title: sources.title, aiExcluded: sources.aiExcluded, deletedAt: sources.deletedAt })
    .from(sources)
    .where(eq(sources.id, id))
    .get()
  return s && !s.aiExcluded && !s.deletedAt ? { title: s.title } : null
}

const fmtDate = (ts: number | null): string => (ts ? new Date(ts).toISOString().slice(0, 10) : '?')

/** 片段 → 带编号的文字（同一片段在一次回答中只编号一次） */
export function numberHits(session: AgentSession, hits: SearchHit[]): string {
  const zh = session.zh
  const STATUS: Record<string, string> = zh
    ? { active: '', outdated: ' · 已过时', disputed: ' · 存疑' }
    : { active: '', outdated: ' · outdated', disputed: ' · disputed' }
  const ORIGIN: Record<string, string> = zh
    ? { user: '', ai: ' · AI 生成未审阅', ai_reviewed: ' · AI 生成经审阅' }
    : { user: '', ai: ' · AI-generated, unreviewed', ai_reviewed: ' · AI-generated, reviewed' }
  return hits
    .map((h) => {
      let n = session.hits.findIndex((x) => x.ownerId === h.ownerId) + 1
      if (!n) {
        session.hits.push(h)
        n = session.hits.length
      }
      const meta =
        h.parentType === 'note'
          ? `${zh ? '笔记' : 'Note'}《${h.title || '—'}》· ${zh ? '学习于' : 'learned'} ${fmtDate(h.learnedAt)} · ${zh ? '修改于' : 'edited'} ${fmtDate(h.updatedAt)}${STATUS[h.status ?? 'active']}${ORIGIN[h.origin ?? 'user']}`
          : `${zh ? '资料' : 'Source'}《${h.title}》${h.locator ? ' · ' + h.locator : ''} · ${zh ? '片段' : 'segment'} ${h.ownerId}`
      return `[${n}] ${meta}\n${h.text}`
    })
    .join('\n\n')
}

/** 笔记结构（供 AI 定位行与段落） */
function describeNote(noteId: string, zh: boolean): string {
  const { doc, embeds } = stateToContent(loadDoc(noteId))
  const out: string[] = []
  const blockLine = (n: DocNode, label: string): string => {
    const text = n.type === 'embed' ? `[${String(embeds[String(n.attrs?.id)]?.kind ?? 'embed')}]` : nodeText(n).trim()
    return `  ${label}[${n.attrs?.id ?? '?'}] ${text || (zh ? '（空）' : '(empty)')}`
  }
  let i = 0
  for (const top of doc.content ?? []) {
    if (top.type === 'cornellRow') {
      i++
      out.push(`${zh ? '行' : 'Row'} ${i}（ID：${top.attrs?.id}）`)
      const cue = top.content?.find((c) => c.type === 'cornellCue')
      const body = top.content?.find((c) => c.type === 'cornellBody')
      for (const c of cue?.content ?? []) out.push(blockLine(c, zh ? '线索' : 'cue'))
      for (const c of body?.content ?? []) out.push(blockLine(c, zh ? '笔记' : 'note'))
    } else if (top.type === 'cornellSummary') {
      out.push(zh ? '总结' : 'Summary')
      for (const c of top.content ?? []) out.push(blockLine(c, ''))
    }
  }
  return out.join('\n').slice(0, 30_000)
}

/** 空线索栏中的段落 ID（用于填线索） */
function emptyCueParagraph(noteId: string, rowId: string): string | null {
  const { doc } = stateToContent(loadDoc(noteId))
  const row = doc.content?.find((r) => r.type === 'cornellRow' && r.attrs?.id === rowId)
  const cue = row?.content?.find((c) => c.type === 'cornellCue')
  if (!cue) return null
  if (nodeText(cue).trim()) return null
  const p = cue.content?.[0]
  return typeof p?.attrs?.id === 'string' ? p.attrs.id : null
}

const mustNote = (noteId: string, zh: boolean): string => {
  const n = readableNote(noteId)
  if (!n) throw new Error(zh ? '找不到这篇笔记，或用户设置了不让 AI 读取' : 'Note not found or excluded from AI')
  return n.title
}

const NestedSchema: z.ZodType<NestedNode & { segmentId?: string }> = z.lazy(() =>
  z.object({
    text: z.string().min(1).max(200),
    segmentId: z.string().max(64).optional().describe('来自资料时：对应的片段 ID'),
    children: z.array(NestedSchema).max(12).optional()
  })
) as never

export function buildTools(s: AgentSession): ToolSet {
  const zh = s.zh
  const proposal = (
    noteId: string,
    title: string,
    ops: ProposalOp[],
    extra?: { embeds?: Record<string, { kind: string; data: unknown }>; segs?: string[] }
  ) => {
    const p = createProposal({
      noteId,
      title,
      ops,
      model: s.model,
      embeds: extra?.embeds,
      sources: extra?.segs?.length ? [...new Set(extra.segs)].map((id) => ({ type: 'segment' as const, id })) : undefined
    })
    return zh
      ? `已提交提案“${title}”（${p.ops.length} 处修改），等待用户在笔记中确认。不要在回答中重复提案内容。`
      : `Proposal "${title}" submitted (${p.ops.length} change(s)); the user will review it in the note.`
  }

  const tools: ToolSet = {
    skills_load: tool({
      description: zh ? '加载一个技能的完整流程（技能目录见系统提示）' : 'Load the full instructions of a skill',
      inputSchema: z.object({ name: z.string().max(64) }),
      execute: async ({ name }) => {
        const body = loadSkill(name, zh)
        if (!s.skills.includes(name)) s.skills.push(name)
        return body
      }
    }),
    skills_read_file: tool({
      description: zh ? '读取技能附带的参考文件' : 'Read a file bundled with a skill',
      inputSchema: z.object({ name: z.string().max(64), path: z.string().max(200) }),
      execute: async ({ name, path }) => readSkillFile(name, path)
    })
  }

  if (s.scope.type !== 'none') {
    Object.assign(tools, {
      knowledge_search: tool({
        description: zh
          ? '在用户的知识库（笔记 + 资料）中检索。结果带编号，回答时用 [编号] 引用。已提供的片段不够时再用。'
          : "Search the user's knowledge base (notes + sources). Results are numbered; cite as [n].",
        inputSchema: z.object({ query: z.string().min(1).max(500) }),
        execute: async ({ query }) => {
          const hits = await retrieve(query, s.scope, 6)
          return hits.length ? numberHits(s, hits) : zh ? '没有找到相关内容。' : 'Nothing found.'
        }
      }),
      note_find: tool({
        description: zh ? '按标题或内容关键词查找笔记，返回笔记 ID 与标题' : 'Find notes by keyword; returns IDs and titles',
        inputSchema: z.object({ query: z.string().min(1).max(200) }),
        execute: async ({ query }) => {
          const list = listNotes({ search: query, limit: 10 }).filter((n) => !n.aiExcluded)
          return list.length ? list.map((n) => `${n.id} · ${n.title || '—'}`).join('\n') : zh ? '没有找到。' : 'None.'
        }
      }),
      note_read: tool({
        description: zh
          ? '读取笔记的结构：每一行的 ID、线索与笔记段落（带段落 ID）、总结。修改笔记前先读。'
          : 'Read a note: rows (IDs), cue/note blocks with IDs, summary. Read before editing.',
        inputSchema: z.object({ noteId: z.string().max(64) }),
        execute: async ({ noteId }) => `《${mustNote(noteId, zh)}》\n${describeNote(noteId, zh)}`
      }),
      source_read: tool({
        description: zh
          ? '读取资料的片段（带片段 ID 与位置）。from 为起始序号（从 0 开始），一次最多 20 段。'
          : 'Read source segments (with IDs and locations). from = start index, up to 20.',
        inputSchema: z.object({
          sourceId: z.string().max(64),
          from: z.number().int().min(0).optional(),
          count: z.number().int().min(1).max(20).optional()
        }),
        execute: async ({ sourceId, from = 0, count = 12 }) => {
          const src = readableSource(sourceId)
          if (!src) throw new Error(zh ? '找不到这份资料，或用户设置了不让 AI 读取' : 'Source not found or excluded')
          const segs = listSegments(sourceId)
          const part = segs.slice(from, from + count)
          const loc = (l: Record<string, unknown>): string => (l.value ? ` · ${String(l.value)}` : '')
          return [
            `《${src.title}》${zh ? `共 ${segs.length} 段，当前 ${from}–${from + part.length - 1}` : ` ${segs.length} segments`}`,
            ...part.map((g) => `[${g.id}${loc(g.locator)}] ${g.text}`)
          ].join('\n')
        }
      })
    })
  }

  Object.assign(tools, {
    note_add_rows: tool({
      description: zh
        ? '在笔记中新增康奈尔行（提案）。cue 为线索栏问题，body 为笔记栏内容，均用 Markdown。afterRowId 省略则加到末尾。'
        : 'Add Cornell rows (proposal). cue/body in Markdown. Omit afterRowId to append.',
      inputSchema: z.object({
        noteId: z.string().max(64),
        title: z
          .string()
          .min(1)
          .max(100)
          .describe(zh ? '一句话说明这次修改' : 'One-line summary'),
        afterRowId: z.string().max(64).optional(),
        rows: z
          .array(z.object({ cue: z.string().max(500), body: z.string().min(1).max(8000) }))
          .min(1)
          .max(20),
        segmentIds: z
          .array(z.string().max(64))
          .max(50)
          .optional()
          .describe(zh ? '依据的资料片段 ID' : 'Source segment IDs used')
      }),
      execute: async ({ noteId, title, afterRowId, rows, segmentIds }) => {
        mustNote(noteId, zh)
        // 依次插入：后一行插在前一行之后无法预知 ID，因此倒序插在同一位置，保持顺序
        const ops: ProposalOp[] = [...rows].reverse().map((r) => ({
          op: 'insert_row',
          afterRowId: afterRowId ?? null,
          cue: r.cue.trim() ? markdownToNodes(r.cue) : [],
          body: markdownToNodes(r.body)
        }))
        return proposal(noteId, title, afterRowId ? ops : ops.reverse(), { segs: segmentIds })
      }
    }),
    note_set_cues: tool({
      description: zh ? '为线索栏为空的行填写问题（提案）。' : 'Fill empty cue cells with questions (proposal).',
      inputSchema: z.object({
        noteId: z.string().max(64),
        cues: z
          .array(z.object({ rowId: z.string().max(64), question: z.string().min(1).max(200) }))
          .min(1)
          .max(50)
      }),
      execute: async ({ noteId, cues }) => {
        mustNote(noteId, zh)
        const ops: ProposalOp[] = []
        const skipped: string[] = []
        for (const c of cues) {
          const pid = emptyCueParagraph(noteId, c.rowId)
          if (pid) ops.push({ op: 'replace_block', blockId: pid, nodes: markdownToNodes(c.question) })
          else skipped.push(c.rowId)
        }
        if (!ops.length)
          throw new Error(
            zh ? '这些行的线索栏都不是空的（或行 ID 不对），请先用 note_read 确认。' : 'No empty cue cells matched; check with note_read.'
          )
        const msg = proposal(noteId, zh ? `生成 ${ops.length} 个线索问题` : `Add ${ops.length} cue questions`, ops)
        return skipped.length ? `${msg}\n${zh ? '跳过（线索栏非空或 ID 不对）' : 'Skipped'}：${skipped.join(', ')}` : msg
      }
    }),
    note_set_summary: tool({
      description: zh ? '写入或补充笔记底部的总结（提案），Markdown。' : 'Write/append the note summary (proposal), Markdown.',
      inputSchema: z.object({ noteId: z.string().max(64), markdown: z.string().min(1).max(4000) }),
      execute: async ({ noteId, markdown }) => {
        mustNote(noteId, zh)
        return proposal(noteId, zh ? '补充总结' : 'Update summary', [{ op: 'append_summary', nodes: markdownToNodes(markdown) }])
      }
    }),
    note_replace_block: tool({
      description: zh
        ? '把笔记中的一个段落替换为新内容（提案，用户可对比前后再决定），Markdown。'
        : 'Replace one block with new Markdown content (proposal).',
      inputSchema: z.object({
        noteId: z.string().max(64),
        blockId: z.string().max(64),
        title: z.string().min(1).max(100),
        markdown: z.string().min(1).max(8000)
      }),
      execute: async ({ noteId, blockId, title, markdown }) => {
        mustNote(noteId, zh)
        return proposal(noteId, title, [{ op: 'replace_block', blockId, nodes: markdownToNodes(markdown) }])
      }
    }),
    note_add_mindmap: tool({
      description: zh
        ? '在笔记中插入一行思维导图（提案）。tree 为嵌套结构 {text, segmentId?, children?}。'
        : 'Insert a mind map row (proposal). tree = nested {text, segmentId?, children?}.',
      inputSchema: z.object({
        noteId: z.string().max(64),
        cue: z
          .string()
          .min(1)
          .max(200)
          .describe(zh ? '这张图回答的问题' : 'Question the map answers'),
        afterRowId: z.string().max(64).optional(),
        tree: NestedSchema
      }),
      execute: async ({ noteId, cue, afterRowId, tree }) => {
        mustNote(noteId, zh)
        const segs: string[] = []
        const conv = (n: NestedNode & { segmentId?: string; children?: (NestedNode & { segmentId?: string })[] }): NestedNode => {
          if (n.segmentId) segs.push(n.segmentId)
          return {
            text: n.text,
            ...(n.segmentId ? { anchor: { type: 'segment' as const, id: n.segmentId } } : {}),
            ...(n.children?.length ? { children: n.children.map(conv) } : {})
          }
        }
        const data = fromNested(conv(tree), () => newId().slice(-12))
        const count = Object.keys(data.nodes).length
        if (count < 3) throw new Error(zh ? '导图太简单（少于 3 个节点）' : 'Mind map too small')
        const embedKey = 'mm'
        return proposal(
          noteId,
          zh ? `思维导图：${tree.text}` : `Mind map: ${tree.text}`,
          [
            {
              op: 'insert_row',
              afterRowId: afterRowId ?? null,
              cue: markdownToNodes(cue),
              body: [{ type: 'embed', attrs: { id: embedKey, kind: 'mindmap' } }]
            }
          ],
          { embeds: { [embedKey]: { kind: 'mindmap', data } }, segs }
        )
      }
    })
  })

  if (!s.incognito) {
    Object.assign(tools, {
      memory_remember: tool({
        description: zh
          ? '记住关于用户的长期信息，让以后的回答更贴合。仅在用户明确要求“记住”，或表达了稳定的偏好、目标、背景、个人术语时使用；一次性的请求不要记。'
          : 'Remember lasting info about the user (explicit requests, stable preferences, goals, background, personal terms). Not for one-off requests.',
        inputSchema: z.object({
          kind: z
            .enum(['preference', 'fact', 'glossary', 'skill'])
            .describe(zh ? 'preference 偏好；fact 关于用户的事实；glossary 用户的术语或简称；skill 对某个技能输出的偏好' : 'Category'),
          content: z
            .string()
            .min(2)
            .max(300)
            .describe(zh ? '用第三人称写成一句完整的话，如“喜欢先看结论再看推导”' : 'One full sentence'),
          skill: z
            .string()
            .max(64)
            .optional()
            .describe(zh ? 'kind 为 skill 时：技能名称' : 'Skill name when kind=skill'),
          sensitive: z
            .boolean()
            .describe(zh ? '涉及健康、财务、人际关系、身份证件等敏感信息时为 true' : 'True for health, finance, relationships, IDs')
        }),
        execute: async ({ kind, content, skill, sensitive }) => {
          const m = saveMemory({ kind, content, skill, sensitive }, 'ai', { conversationId: s.conversationId, messageId: s.messageId })
          return m.status === 'pending'
            ? zh
              ? '这是敏感信息，已请用户确认后再记住。'
              : 'Sensitive: waiting for user confirmation.'
            : zh
              ? '已记住（用户可以撤销）。'
              : 'Remembered (user can undo).'
        }
      }),
      memory_search: tool({
        description: zh
          ? '回忆关于用户的更多信息（偏好、背景、术语）。用户卡片里没有、但回答需要时使用。'
          : 'Recall more about the user when needed.',
        inputSchema: z.object({ query: z.string().min(1).max(200) }),
        execute: async ({ query }) => {
          const list = searchMemories(query, 8)
          return list.length ? list.map((m) => `- ${m.content}`).join('\n') : zh ? '没有相关记忆。' : 'Nothing.'
        }
      })
    })
  }
  return tools
}

/** 步骤说明（给用户看） */
export function stepLabel(name: string, input: unknown, zh: boolean): Pick<AgentStep, 'label' | 'link'> {
  const i = (input ?? {}) as Record<string, unknown>
  const q = (k: string): string => String(i[k] ?? '').slice(0, 40)
  const note = typeof i.noteId === 'string' ? { link: { type: 'note' as const, id: i.noteId } } : {}
  const L: Record<string, [string, string]> = {
    skills_load: [`使用技能：${q('name')}`, `Using skill: ${q('name')}`],
    skills_read_file: [`读取技能参考：${q('path')}`, `Reading skill file: ${q('path')}`],
    knowledge_search: [`检索知识库：${q('query')}`, `Searching: ${q('query')}`],
    note_find: [`查找笔记：${q('query')}`, `Finding notes: ${q('query')}`],
    note_read: ['阅读笔记', 'Reading note'],
    source_read: ['阅读资料', 'Reading source'],
    note_add_rows: [`提案：${q('title')}`, `Proposal: ${q('title')}`],
    note_set_cues: ['提案：生成线索问题', 'Proposal: cue questions'],
    note_set_summary: ['提案：补充总结', 'Proposal: summary'],
    note_replace_block: [`提案：${q('title')}`, `Proposal: ${q('title')}`],
    note_add_mindmap: ['提案：思维导图', 'Proposal: mind map'],
    memory_remember: [`记住：${q('content')}`, `Remembering: ${q('content')}`],
    memory_search: [`回忆：${q('query')}`, `Recalling: ${q('query')}`]
  }
  const link = name === 'source_read' && typeof i.sourceId === 'string' ? { link: { type: 'source' as const, id: i.sourceId } } : note
  return { label: (L[name] ?? [name, name])[zh ? 0 : 1], ...link }
}
