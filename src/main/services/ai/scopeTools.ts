import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { sources } from '../../db/schema'
import type { ToolMeta } from '../agent/wrap'
import { describeDigest, sourceOutline, sourceSize, startDigest, type DigestInput } from '../digest'

// 范围（v0.7.6）：用户没说清楚要整理哪部分时先问；整份资料交给后台分批整理，而不是读开头几页就当作全书。

export const ASK_USER = 'ask_user'

function readable(id: string, zh: boolean): { title: string } {
  const r = getDb()
    .select({ title: sources.title, aiExcluded: sources.aiExcluded, deletedAt: sources.deletedAt })
    .from(sources)
    .where(eq(sources.id, id))
    .get()
  if (!r || r.deletedAt) throw new Error(zh ? `没有 ID 为 ${id} 的资料` : `No source ${id}`)
  if (r.aiExcluded) throw new Error(zh ? '用户设置了这份资料不给 AI' : 'Source excluded from AI')
  return r
}

export function buildScopeTools(
  zh: boolean,
  chat: { providerId: string; model: string }
): { tools: ToolSet; meta: Record<string, ToolMeta> } {
  const digestInput = (i: Record<string, unknown>): DigestInput => ({
    sourceId: String(i.sourceId ?? ''),
    task: (i.task as DigestInput['task']) ?? 'mindmap',
    fromPage: typeof i.fromPage === 'number' ? i.fromPage : undefined,
    toPage: typeof i.toPage === 'number' ? i.toPage : undefined,
    noteId: typeof i.noteId === 'string' ? i.noteId : null,
    providerId: chat.providerId,
    model: chat.model
  })
  const tools: ToolSet = {
    [ASK_USER]: tool({
      description: zh
        ? '向用户提一个选择题（界面上显示为可点的选项），用于范围或意图不明确时，例如“要为哪部分做导图：当前页 / 第 3 章 / 整份资料”。调用后本轮结束，等用户选择。不要用它问可以自己判断的事。'
        : 'Ask the user a multiple-choice question (shown as clickable options) when scope or intent is unclear, e.g. which part to map. The turn ends after calling it. Do not ask what you can decide yourself.',
      inputSchema: z.object({
        question: z.string().min(1).max(200),
        options: z.array(z.string().min(1).max(60)).min(2).max(5)
      }),
      execute: async () =>
        zh
          ? '已在界面上把选项展示给用户。本轮到此结束：用一句话复述问题即可，等用户选择后再继续。'
          : 'Options shown to the user. End this turn with the question in one sentence and wait.'
    }),
    source_outline: tool({
      description: zh
        ? '查看资料的规模（段数、页数）与章节目录（带页码）。整理资料前先用它判断范围、给用户列出可选的章节。'
        : 'Get a source’s size (segments, pages) and chapter list with pages, to decide scope or list chapters for the user.',
      inputSchema: z.object({ sourceId: z.string().max(64) }),
      execute: async ({ sourceId }) => {
        const src = readable(sourceId, zh)
        const size = sourceSize(sourceId)
        const outline = sourceOutline(sourceId)
        return [
          zh
            ? `《${src.title}》共 ${size.segments} 段、约 ${Math.round(size.chars / 1000)} 千字${size.pages ? `、${size.pages} 页` : ''}。一次对话最多能读几十段；超过约 40 段的范围请用 source_digest 交给后台分批整理。`
            : `"${src.title}": ${size.segments} segments, ~${Math.round(size.chars / 1000)}k chars${size.pages ? `, ${size.pages} pages` : ''}. Use source_digest for ranges beyond ~40 segments.`,
          outline.length
            ? (zh ? '章节：\n' : 'Chapters:\n') + outline.map((o) => `- ${o.title}${o.page ? ` · p.${o.page}` : ''}`).join('\n')
            : zh
              ? '没有识别出章节标题。'
              : 'No chapter headings detected.'
        ].join('\n')
      }
    }),
    source_digest: tool({
      description: zh
        ? '把整份资料或一个页码范围在后台分批读完，整理成思维导图 / 总结 / 康奈尔提纲，作为提案放进笔记（noteId 不填则新建一篇）。范围较大（超过约 40 段）时必须用它，不要只读开头几段就当作全书。会先请用户确认预计费用。'
        : 'Read a whole source or page range in the background and turn it into a mind map / summary / Cornell outline proposal in a note (new note if noteId is empty). Required for large ranges. The user confirms the estimated cost first.',
      inputSchema: z.object({
        sourceId: z.string().max(64),
        task: z.enum(['mindmap', 'summary', 'outline']),
        fromPage: z.number().int().min(1).optional(),
        toPage: z.number().int().min(1).optional(),
        noteId: z.string().max(64).optional()
      }),
      execute: async (input) => {
        readable(input.sourceId, zh)
        const { noteId } = startDigest(digestInput(input))
        return zh
          ? `已在后台开始整理（笔记 ID：${noteId}）。完成后会作为提案出现在这篇笔记里，界面会提示用户。用一句话告诉用户：已开始，可以在“后台任务”里看进度。`
          : `Started in the background (note ${noteId}). It will arrive as a proposal; tell the user in one sentence.`
      }
    })
  }
  const meta: Record<string, ToolMeta> = {
    [ASK_USER]: { level: 'read' },
    source_outline: { level: 'read' },
    source_digest: {
      level: 'write',
      confirm: true,
      describe: (i) => describeDigest(digestInput(i), zh),
      check: (i) => {
        try {
          readable(String(i.sourceId ?? ''), zh)
          return null
        } catch (e) {
          return e instanceof Error ? e.message : String(e)
        }
      }
    }
  }
  return { tools, meta }
}
