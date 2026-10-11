import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { MistakeSubjectSchema } from '@shared/mistakes'
import { InboxCreateSchema } from '@shared/inbox'
import type { DocNode } from '@shared/types'
import { createAction, listActions, updateAction } from '../reflection'
import { goalProgress, listGoals, saveGoal } from '../progress'
import * as inbox from '../inbox'
import * as mistakes from '../mistakes'
import { requireMistakeCloud } from '../mistakesPrivacy'
import { createNote, getNote } from '../notes'
import { replaceDoc } from '../docs'
import { markdownToNodes } from '../../lib/markdown'
import { localDate } from '../stats'
import type { ToolMeta } from '../agent/wrap'
import { EventRange } from '@shared/plan'
import * as plan from '../plan/calendar'

// 助手“办事”（v0.7）：跨模块的读与写。写入工具执行前在对话中弹出确认卡片（wrap.ts），
// 卡片上的文字由 describe 生成，写清楚要做什么，而不是工具名和参数。

const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD')
const atNoon = (d: string): number => new Date(`${d}T12:00:00`).getTime()
const fmtDay = (zh: boolean, d?: string | null): string => {
  if (!d) return ''
  const [, m, day] = d.split('-').map(Number)
  return zh ? `${m} 月 ${day} 日` : d
}
/**
 * 模型偶尔把整段内容多转义一层（字面的 \n、\\frac）：只有字面 \n、没有真正换行时，整体还原一层。
 * 只还原 \\、\n、\"，不碰 \t（避免把 \times 变成制表符）。
 */
export const unescapeNewlines = (s: string): string =>
  !s.includes('\n') && s.includes('\\n') ? s.replace(/\\(\\|n|")/g, (_, c: string) => (c === 'n' ? '\n' : c)) : s
/** 公式里的反斜杠被吞掉（frac{、fracsin、cdot……）或多了一层（\\\\frac）：转义出错，退回给模型重写 */
export function brokenLatex(md: string, zh: boolean): string | null {
  const maths = md.match(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g) ?? []
  // 去掉写对了的命令后，还剩下 frac{、cdot、lim_ 这类裸词，说明反斜杠被吞了
  const bad = maths.find(
    (m) =>
      /\\\\[a-zA-Z]/.test(m) ||
      /frac[{a-z]|cdot|infty|sqrt[{[]|left[([|]|right[)\]|]|lim_|[a-z]to(0|inf)/.test(m.replace(/\\[a-zA-Z]+/g, ''))
  )
  if (!bad) return null
  return zh
    ? `公式的反斜杠转义有误（例如 ${bad.slice(0, 40)}），通常是 JSON 转义多了或少了一层。请把 LaTeX 命令写成 \\frac、\\lim 这样（JSON 里是两个反斜杠），换行直接换行，然后重新提交。`
    : `LaTeX backslashes are mis-escaped (e.g. ${bad.slice(0, 40)}). Escape commands like \\frac properly in JSON and resubmit.`
}
const bare = (t: string): string => t.trim().replace(/^《(.+)》$/, '$1')
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const SUBJECT_ZH: Record<string, string> = { math: '数学', physics: '物理', chemistry: '化学', english: '英语', other: '其他' }

export function buildDoTools(zh: boolean): { tools: ToolSet; meta: Record<string, ToolMeta> } {
  const tools: ToolSet = {
    plan_list: tool({
      description: zh ? '查询某段时间的日程与复习负荷；可指定方向。排计划需到方向详情的排计划按钮预览。' : 'Read calendar and review load for a time range, optionally for a direction. Scheduling requires the preview in Directions.',
      inputSchema: EventRange.extend({ goalId: z.string().optional() }),
      execute: async ({ startAt, endAt, goalId }) => JSON.stringify({ goalId, guidance: zh ? '在方向详情点“排计划”，预览后确认写入。' : 'Open the direction and choose Schedule a plan; confirm the preview.', events: plan.events({ startAt, endAt }).filter((e) => !goalId || e.goalId === goalId), forecast: plan.forecast(Math.min(366, Math.max(1, Math.ceil((endAt - Date.now()) / 86400000)))) })
    }),
    plan_event_create: tool({
      description: zh ? '用户确认后在日历上新建日程。' : 'Create a calendar event after the user confirms.',
      inputSchema: z.object({ title: z.string().min(1).max(300), startAt: z.number().int(), endAt: z.number().int(), kind: z.enum(['study', 'exam', 'deadline', 'event']).default('study'), goalId: z.string().nullable().optional() }),
      execute: async (input) => { const e = plan.eventSave(input); return zh ? `已创建日程（${e.id}）。` : `Event created (${e.id}).` }
    }),
    actions_list: tool({
      description: zh ? '列出未完成的行动项（ID、标题、截止日期）' : 'List open action items (ID, title, due date)',
      inputSchema: z.object({}),
      execute: async () => {
        const list = listActions('open')
        if (!list.length) return zh ? '没有未完成的行动项。' : 'No open actions.'
        return list
          .slice(0, 50)
          .map((a) => `${a.id} · ${a.title}${a.dueAt ? ` · ${zh ? '截止' : 'due'} ${localDate(new Date(a.dueAt))}` : ''}`)
          .join('\n')
      }
    }),
    goals_list: tool({
      description: zh ? '列出方向：掌握度、剩余天数、关联笔记数' : 'List learning goals with mastery and days left',
      inputSchema: z.object({}),
      execute: async () => {
        const goals = listGoals().filter((g) => g.status === 'active')
        if (!goals.length) return zh ? '还没有进行中的方向。' : 'No active goals.'
        return goals
          .map((g) => {
            const p = goalProgress(g.id)
            const pct = p.cards ? Math.round(p.mastered * 100) : null
            return zh
              ? `${g.id} · ${g.title}${g.targetAt ? ` · 截止 ${localDate(new Date(g.targetAt))}（还剩 ${p.daysLeft ?? '?'} 天）` : ''} · 笔记 ${p.notes} 篇 · ${pct === null ? '还没有复习卡片' : `掌握 ${pct}%`}`
              : `${g.id} · ${g.title}${g.targetAt ? ` · due ${localDate(new Date(g.targetAt))} (${p.daysLeft ?? '?'} days left)` : ''} · ${p.notes} notes · ${pct === null ? 'no cards' : `${pct}% mastered`}`
          })
          .join('\n')
      }
    }),
    mistakes_list: tool({
      description: zh
        ? '列出错题本里的题目（科目、知识点、错因、题干、正确答案）。可按科目、知识点、最近几天筛选。用于“出一套练习卷”“看看最近错在哪”。'
        : 'List mistakes (subject, concepts, cause, question, answer). Filter by subject, concept, recent days.',
      inputSchema: z.object({
        subject: MistakeSubjectSchema.optional(),
        concept: z.string().max(40).optional(),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe(zh ? '最近几天' : 'Recent days'),
        limit: z.number().int().min(1).max(40).optional()
      }),
      execute: async ({ subject, concept, days, limit = 20 }) => {
        const list = mistakes.list({ subject, concept, since: days ? Date.now() - days * 86_400_000 : undefined }).slice(0, limit)
        if (!list.length) return zh ? '没有符合条件的错题。' : 'No matching mistakes.'
        return list
          .map((m, i) => {
            let open = true
            try {
              requireMistakeCloud(m.id)
            } catch {
              open = false
            }
            const head = `${i + 1}. [${zh ? (SUBJECT_ZH[m.subject] ?? m.subject) : m.subject}] ${m.concepts.join('、') || '—'} · ${localDate(new Date(m.createdAt))}`
            if (!open) return `${head}\n${zh ? '（这道题设为仅本地，内容不提供给 AI）' : '(local-only; content withheld)'}`
            return `${head}\n${zh ? '题目' : 'Q'}：${cut(m.question, 600)}\n${zh ? '正确答案' : 'Answer'}：${cut(m.correctAnswer || '—', 300)}${m.causeReason ? `\n${zh ? '错因' : 'Cause'}：${cut(m.causeReason, 160)}` : ''}`
          })
          .join('\n\n')
      }
    }),
    action_create: tool({
      description: zh
        ? '新建一个行动项（要做的一件具体的事），可设截止日期。用户确认后才会创建。'
        : 'Create an action item, optionally with a due date. Created after the user confirms.',
      inputSchema: z.object({ title: z.string().min(1).max(200), due: DateStr.optional() }),
      execute: async ({ title, due }) => {
        const a = createAction(title.trim(), due ? atNoon(due) : null)
        return zh ? `已创建行动项（${a.id}）。` : `Action created (${a.id}).`
      }
    }),
    action_complete: tool({
      description: zh ? '把一个行动项标记为完成（先用 actions_list 找到 ID）。' : 'Mark an action as done (find its ID with actions_list).',
      inputSchema: z.object({ actionId: z.string().max(64) }),
      execute: async ({ actionId }) => {
        updateAction(actionId, { status: 'done' })
        return zh ? '已标记完成。' : 'Marked done.'
      }
    }),
    goal_create: tool({
      description: zh
        ? '新建一个方向（如“六月通过考研数学一”），可设截止日期。用户确认后才会创建。'
        : 'Create a learning goal with an optional deadline.',
      inputSchema: z.object({ title: z.string().min(1).max(200), due: DateStr.optional(), description: z.string().max(1000).optional() }),
      execute: async ({ title, due, description }) => {
        const g = saveGoal({ title: title.trim(), targetAt: due ? atNoon(due) : null, description: description ?? null })
        return zh ? `已创建方向（${g.id}）。` : `Goal created (${g.id}).`
      }
    }),
    inbox_add: tool({
      description: zh ? '把一段文字放进收件箱，稍后整理进笔记。' : 'Put a piece of text into the inbox for later sorting.',
      inputSchema: z.object({ text: z.string().min(1).max(4000) }),
      execute: async ({ text }) => {
        const item = inbox.create(InboxCreateSchema.parse({ kind: 'text', text, origin: { app: zh ? '积微助手' : 'Jiwei Assistant' } }))
        return zh ? `已放进收件箱（${item.id}）。` : `Added to inbox (${item.id}).`
      }
    }),
    note_create: tool({
      description: zh
        ? '新建一篇康奈尔笔记：rows 为若干行（cue 线索问题、body 内容，Markdown），summary 为总结。适合“把错题出成一套练习卷”“整理成一篇笔记”。用户确认后才会创建。'
        : 'Create a new Cornell note: rows (cue + body in Markdown) and an optional summary. Created after the user confirms.',
      inputSchema: z.object({
        title: z.string().min(1).max(120),
        rows: z
          .array(z.object({ cue: z.string().max(500), body: z.string().min(1).max(8000) }))
          .min(1)
          .max(40),
        summary: z.string().max(4000).optional()
      }),
      execute: async ({ title, rows, summary }) => {
        const note = createNote({ title: bare(title) })
        const para: DocNode = { type: 'paragraph' }
        const md = (x: string): DocNode[] => markdownToNodes(unescapeNewlines(x))
        const content: DocNode[] = rows.map((r) => ({
          type: 'cornellRow',
          content: [
            { type: 'cornellCue', content: r.cue.trim() ? md(r.cue) : [para] },
            { type: 'cornellBody', content: md(r.body) }
          ]
        }))
        content.push({ type: 'cornellSummary', content: summary?.trim() ? md(summary) : [para] })
        replaceDoc(note.id, { type: 'doc', content })
        return zh ? `已新建笔记《${getNote(note.id)?.title ?? title}》（${note.id}）。` : `Note created (${note.id}).`
      }
    })
  }

  const meta: Record<string, ToolMeta> = {
    plan_list: { level: 'read', untrusted: true },
    plan_event_create: { level: 'write', confirm: true, describe: (i) => ({ title: zh ? `新建日程「${cut(String(i.title ?? ''), 60)}」` : `Create event “${cut(String(i.title ?? ''), 60)}”`, detail: `${new Date(Number(i.startAt)).toLocaleString()} — ${new Date(Number(i.endAt)).toLocaleString()}` }) },
    actions_list: { level: 'read' },
    goals_list: { level: 'read' },
    mistakes_list: { level: 'read' },
    action_create: {
      level: 'write',
      confirm: true,
      describe: (i) => ({
        title: zh
          ? `新建行动项「${cut(String(i.title ?? ''), 60)}」${i.due ? `，截止 ${fmtDay(zh, String(i.due))}` : ''}`
          : `Create action “${cut(String(i.title ?? ''), 60)}”${i.due ? `, due ${String(i.due)}` : ''}`
      })
    },
    action_complete: {
      level: 'write',
      confirm: true,
      describe: (i) => {
        const a = listActions('open').find((x) => x.id === i.actionId)
        return {
          title: zh ? `把行动项「${cut(a?.title ?? String(i.actionId ?? ''), 60)}」标记为完成` : `Mark “${cut(a?.title ?? '', 60)}” done`
        }
      }
    },
    goal_create: {
      level: 'write',
      confirm: true,
      describe: (i) => ({
        title: zh
          ? `新建方向「${cut(String(i.title ?? ''), 60)}」${i.due ? `，截止 ${fmtDay(zh, String(i.due))}` : ''}`
          : `Create goal “${cut(String(i.title ?? ''), 60)}”${i.due ? `, due ${String(i.due)}` : ''}`
      })
    },
    inbox_add: {
      level: 'write',
      confirm: true,
      describe: (i) => ({ title: zh ? '放进收件箱' : 'Add to inbox', detail: cut(String(i.text ?? ''), 200) })
    },
    note_create: {
      level: 'write',
      confirm: true,
      check: (i) => {
        const rows = Array.isArray(i.rows) ? (i.rows as { cue?: string; body?: string }[]) : []
        const fields = [...rows.flatMap((r) => [r.cue ?? '', r.body ?? '']), String(i.summary ?? '')].map(unescapeNewlines)
        return brokenLatex(fields.join('\n'), zh)
      },
      describe: (i) => {
        const rows = Array.isArray(i.rows) ? (i.rows as { cue?: string }[]) : []
        return {
          title: zh
            ? `新建笔记《${cut(bare(String(i.title ?? '')), 60)}》，共 ${rows.length} 行`
            : `Create note “${cut(String(i.title ?? ''), 60)}” (${rows.length} rows)`,
          detail: rows
            .map((r) => r.cue?.trim())
            .filter(Boolean)
            .slice(0, 6)
            .map((c) => `· ${cut(c!, 60)}`)
            .join('\n')
        }
      }
    }
  }
  return { tools, meta }
}

/** 现有内置工具的级别：改笔记与记住偏好本身是提案，网页内容不可信 */
export const BUILTIN_META: Record<string, ToolMeta> = {
  memory_remember: { level: 'write', proposal: true },
  browser_read_page: { level: 'read', untrusted: true },
  browser_find: { level: 'read', untrusted: true },
  browser_links: { level: 'read', untrusted: true },
  browser_open: { level: 'read' }
}
export const isProposalTool = (name: string): boolean =>
  name.startsWith('note_') && name !== 'note_find' && name !== 'note_read' && name !== 'note_create'
