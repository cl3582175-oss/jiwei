import { z } from 'zod'

export const TaskTrigger = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('schedule'),
      every: z.enum(['day', 'weekday', 'week']),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional()
    })
    .refine((v) => v.every !== 'week' || !!v.days?.length, 'Choose weekdays'),
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(30).max(525600) }),
  z.object({
    type: z.literal('mail'),
    accountId: z.string().min(1),
    from: z.string().max(300).optional(),
    subjectContains: z.string().max(300).optional()
  }),
  z.object({
    type: z.literal('web'),
    url: z
      .url()
      .max(4000)
      .refine((v) => /^https?:\/\//i.test(v)),
    selector: z.string().max(500).optional()
  }),
  z.object({ type: z.literal('folder'), path: z.string().min(1).max(4000) }),
  z.object({
    type: z.literal('calendar'),
    minutesBefore: z.number().int().min(0).max(10080),
    kind: z.enum(['exam', 'event', 'study']).optional()
  }),
  z.object({ type: z.literal('mistakes'), count: z.number().int().min(1).max(1000) }),
  z.object({ type: z.literal('deadline'), days: z.number().int().min(0).max(365) }),
  z.object({ type: z.literal('manual') })
])
export type Trigger = z.infer<typeof TaskTrigger>
export function taskTriggerText(t: Trigger, zh: boolean): string {
  const days = zh ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  switch (t.type) {
    case 'schedule':
      return `${t.every === 'day' ? (zh ? '每天' : 'Daily') : t.every === 'weekday' ? (zh ? '工作日' : 'Weekdays') : t.days?.map((d) => days[d]).join(', ')} ${t.time}`
    case 'interval':
      return zh ? `每 ${t.minutes} 分钟` : `Every ${t.minutes} minutes`
    case 'mail':
      return zh ? `新邮件${t.from ? `（发件人：${t.from}）` : ''}` : `New mail${t.from ? ` from ${t.from}` : ''}`
    case 'web':
      return zh ? `网页变化：${t.url}` : `Web change: ${t.url}`
    case 'folder':
      return zh ? `文件夹新文件：${t.path}` : `New files: ${t.path}`
    case 'calendar':
      return zh ? `日程前 ${t.minutesBefore} 分钟` : `${t.minutesBefore} minutes before an event`
    case 'mistakes':
      return zh ? `累计 ${t.count} 道错题` : `${t.count} accumulated mistakes`
    case 'deadline':
      return zh ? `方向截止前 ${t.days} 天` : `${t.days} days before a direction deadline`
    case 'manual':
      return zh ? '手动' : 'Manual'
  }
}
export function taskConfirmation(input: TaskInput, zh: boolean): string {
  const labels = zh
    ? { inbox: '收件箱', briefing: '今日任务结果', notify: '系统通知', noteId: '笔记提案', actions: '行动项' }
    : { inbox: 'Inbox', briefing: 'Today’s results', notify: 'Notification', noteId: 'Note proposal', actions: 'Actions' }
  return [
    `${zh ? '触发' : 'Trigger'}：${taskTriggerText(input.trigger, zh)}`,
    `${zh ? '指令' : 'Instruction'}：${input.instruction.slice(0, 300)}`,
    `${zh ? '工具' : 'Tools'}：${input.tools.join(', ') || (zh ? '无读取工具' : 'No reading tools')}`,
    `${zh ? '去向' : 'Destinations'}：${
      Object.keys(labels)
        .filter((k) => input.outputs[k as keyof typeof input.outputs])
        .map((k) => labels[k as keyof typeof labels])
        .join(', ') || '—'
    }`
  ].join('\n')
}
export const TaskOutputs = z.object({
  inbox: z.literal(true).optional(),
  briefing: z.literal(true).optional(),
  notify: z.literal(true).optional(),
  noteId: z.string().min(1).optional(),
  actions: z.literal(true).optional()
})
export const TaskSave = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(150),
  instruction: z.string().trim().min(1).max(12000),
  trigger: TaskTrigger,
  tools: z.array(z.string().min(1).max(200)).max(100),
  outputs: TaskOutputs,
  budgetPerRun: z.number().min(0).max(10000).nullable().default(null),
  enabled: z.boolean().default(true),
  recipe: z.string().max(100).nullable().default(null)
})
export type TaskInput = z.input<typeof TaskSave>
export interface AiTask extends Omit<z.infer<typeof TaskSave>, 'id'> {
  id: string
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: TaskRun | null
  monthCost: number
}
export const TaskRunStatus = z.enum(['running', 'ok', 'error', 'skipped', 'budget', 'canceled'])
export interface TaskResultRef {
  type: 'inbox' | 'proposal' | 'action' | 'note' | 'briefing'
  id: string
  noteId?: string
}
export interface TaskRun {
  id: string
  taskId: string
  startedAt: number
  endedAt: number | null
  status: z.infer<typeof TaskRunStatus>
  delayed: boolean
  triggerInfo: Record<string, unknown>
  cost: number
  summary: string | null
  resultRefs: TaskResultRef[]
  error: string | null
  conversationId: string | null
}
export interface TaskToolInfo {
  name: string
  group: 'knowledge' | 'plan' | 'mail' | 'web' | 'mcp'
  label: string
  available: boolean
  reason?: string
}
export const TASK_READ_TOOLS = [
  'knowledge_search',
  'note_find',
  'note_read',
  'source_read',
  'today_overview',
  'plan_list',
  'actions_list',
  'goals_list',
  'mistakes_list',
  'web_fetch'
] as const
export const TaskSettings = z.object({
  paused: z.boolean().default(false),
  launchAtLogin: z.boolean().default(false),
  keepRunning: z.boolean().default(false)
})
export interface TodayTaskResult {
  id: string
  taskId: string
  name: string
  summary: string
  cost: number
}
