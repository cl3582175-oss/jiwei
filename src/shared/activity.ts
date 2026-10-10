import { z } from 'zod'

/** 学习活动的种类（v0.6.7 学习活动记录层）。时长类由渲染进程按“前台 + 最近有操作或在播放”统计，计数类由主进程在完成节点记录。 */
export const ActivityKindSchema = z.enum(['read', 'listen', 'write', 'review', 'record', 'practice', 'chat'])
export type ActivityKind = z.infer<typeof ActivityKindSchema>
export const ActivityRefSchema = z.enum(['note', 'source', 'web', 'card', 'mistake', 'recording', 'conversation'])
export type ActivityRef = z.infer<typeof ActivityRefSchema>

/** 渲染进程上报的一段有效时长。单条最多 15 分钟（每分钟上报一次，留出余量）。 */
export const ActivitySpanSchema = z.object({
  kind: ActivityKindSchema,
  refType: ActivityRefSchema.nullable(),
  refId: z.string().min(1).max(100).nullable(),
  durationMs: z.number().int().min(1000).max(15 * 60_000)
})
export type ActivitySpan = z.infer<typeof ActivitySpanSchema>
export const ActivityBatchSchema = z.array(ActivitySpanSchema).max(50)

export interface ActivityMinutes {
  read: number
  listen: number
  write: number
  review: number
  record: number
  practice: number
  chat: number
}

/** 「今日」首页需要的全部数字与条目（主进程汇总，渲染进程只负责展示）。 */
export interface TodaySummary {
  date: string
  streak: number
  /** 今天各类有效学习分钟数 */
  minutes: ActivityMinutes
  /** 最近 7 天每天的有效学习分钟数（含今天，按时间顺序） */
  week: { date: string; minutes: number }[]
  review: { due: number; new: number; doneToday: number }
  mistakes: { total: number; unverified: number; practiceReady: number }
  inbox: { pending: number }
  proposals: { pending: number; notes: { noteId: string; title: string; count: number }[] }
  actions: { id: string; title: string; dueAt: number | null; overdue: boolean }[]
  goals: { id: string; title: string; mastered: number; cards: number; daysLeft: number | null; openActions: number }[]
  reflection: { dailyEnabled: boolean; dailyDone: boolean; time: string; weeklyDue: boolean }
  inboxTriageTime: string | null
  recentNotes: { id: string; title: string; editedAt: number }[]
  /** 全新用户：还没有笔记和资料 */
  fresh: boolean
}

export interface TodayBriefing {
  date: string
  text: string
  /** 由模型生成；false 表示按模板生成（没有设置模型或调用失败） */
  ai: boolean
  generatedAt: number
  /** 生成时的要点指纹，要点变化后重新生成 */
  fingerprint?: string
}
