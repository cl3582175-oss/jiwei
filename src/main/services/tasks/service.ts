import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { app } from 'electron'
import { TaskSave, type AiTask, type TaskInput, type TaskRun, type TodayTaskResult } from '@shared/tasks'
import { taskRecipes } from '@shared/taskRecipes'
import { getDb } from '../../db'
import { aiTaskRuns, aiTasks, jobs, notes, meta } from '../../db/schema'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { getSettings, setSettings } from '../settings'
import { emit } from '../../events'
import { enqueue, cancelJob } from '../jobs'
import { nextTriggerAt } from './triggers'
import { structured, quickModel } from '../ai/structured'
import { withRun } from '../agent/context'
import { checkBudget, perRunLimit } from '../agent/usage'
import { clearTriggerState, initializeTrigger } from './scheduler'
import { accountRow } from '../mail/accounts'

export const changed = (): void => emit('tasks:changed', {})
const spendKey = (id: string, at: number): string => {
  const d = new Date(at)
  return `task.spend:${id}:${d.getFullYear()}-${d.getMonth() + 1}`
}
/** 月总额独立于最近一百条运行历史，裁剪历史不能使显示的花费减少。 */
export function recordTaskCost(id: string, at: number, cost: number): void {
  const key = spendKey(id, at)
  const old = Number(getDb().select().from(meta).where(eq(meta.key, key)).get()?.value ?? 0)
  const value = String(old + cost)
  getDb().insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run()
}
export function taskRuns(id: string): TaskRun[] {
  return getDb()
    .select()
    .from(aiTaskRuns)
    .where(eq(aiTaskRuns.taskId, id))
    .orderBy(desc(aiTaskRuns.startedAt))
    .limit(100)
    .all()
    .map((r) => ({ ...r, triggerInfo: JSON.parse(r.triggerInfo), resultRefs: JSON.parse(r.resultRefs) }))
}
export function listTasks(): AiTask[] {
  const db = getDb(),
    month = new Date()
  month.setDate(1)
  month.setHours(0, 0, 0, 0)
  return db
    .select()
    .from(aiTasks)
    .where(isNull(aiTasks.deletedAt))
    .all()
    .map((r) => ({
      ...r,
      trigger: JSON.parse(r.trigger),
      tools: JSON.parse(r.tools),
      outputs: JSON.parse(r.outputs),
      lastResult: taskRuns(r.id)[0] ?? null,
      monthCost: Number(
        db
          .select()
          .from(meta)
          .where(eq(meta.key, spendKey(r.id, Date.now())))
          .get()?.value ??
          db
            .select({ cost: sql<number>`coalesce(sum(${aiTaskRuns.cost}),0)` })
            .from(aiTaskRuns)
            .where(and(eq(aiTaskRuns.taskId, r.id), sql`${aiTaskRuns.startedAt} >= ${month.getTime()}`))
            .get()?.cost ??
          0
      )
    }))
}
export function getTask(id: string): AiTask | undefined {
  return listTasks().find((t) => t.id === id)
}
export async function saveTask(input: TaskInput): Promise<AiTask> {
  const v = TaskSave.parse(input),
    old = v.id ? getTask(v.id) : undefined
  if (v.id && !old) throw new Error('Task not found')
  if (v.enabled && v.recipe === 'daily-picks' && (!v.outputs.inbox || v.outputs.noteId || v.outputs.actions || v.tools.length))
    throw new Error(getSettings().language.startsWith('zh') ? '每日精选配方需要收件箱输出，工具与其他写入由固定发现流程管理' : 'Daily picks requires inbox output; its fixed discovery workflow manages tools and writes')
  // 停用必须始终可用；失效的账号、工具或目标只能阻止启用，不能阻止撤回执行许可。
  if (v.enabled) {
    const { taskToolCatalog } = await import('./tools')
    const catalog = await taskToolCatalog()
    if (v.tools.some((name) => !catalog.tools[name]))
      throw new Error(
        getSettings().language.startsWith('zh') ? '任务包含不可用或不允许的工具' : 'Task contains unavailable or unauthorized tools'
      )
    if (v.trigger.type === 'mail') accountRow(v.trigger.accountId)
    if (v.outputs.noteId) {
      const note = getDb().select().from(notes).where(eq(notes.id, v.outputs.noteId)).get()
      if (!note || note.aiExcluded || note.deletedAt) throw new Error('Output note is unavailable or excluded from AI')
    }
  }
  const id = v.id ?? newId(),
    now = Date.now(),
    triggerChanged = !old || JSON.stringify(old.trigger) !== JSON.stringify(v.trigger)
  if (v.enabled && (triggerChanged || !old?.enabled)) await initializeTrigger(id, v.trigger)
  const row = {
    name: v.name,
    instruction: v.instruction,
    trigger: JSON.stringify(v.trigger),
    tools: JSON.stringify([...new Set(v.tools)]),
    outputs: JSON.stringify(v.outputs),
    budgetPerRun: v.budgetPerRun,
    recipe: v.recipe,
    enabled: v.enabled,
    nextRunAt: triggerChanged || (!old?.enabled && v.enabled) ? nextTriggerAt(v.trigger, now) : old?.nextRunAt,
    updatedAt: now,
    updatedBy: deviceId()
  }
  if (old) getDb().update(aiTasks).set(row).where(eq(aiTasks.id, id)).run()
  else
    getDb()
      .insert(aiTasks)
      .values({ ...row, id, createdAt: now })
      .run()
  if (!v.enabled) cancelTaskJobs(id)
  changed()
  return getTask(id)!
}
function cancelTaskJobs(id: string, afterCommit?: (effect: () => void) => void): void {
  for (const j of getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, 'ai.task'), sql`${jobs.status} IN ('running','queued')`))
    .all())
    if (JSON.parse(j.payload).taskId === id) cancelJob(j.id, afterCommit)
}
export function removeTask(id: string, afterCommit?: (effect: () => void) => void): void {
  cancelTaskJobs(id, afterCommit)
  getDb().update(aiTasks).set({ deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(aiTasks.id, id)).run()
  clearTriggerState(id)
  changed()
}
export function pauseAll(paused: boolean): void {
  setSettings({ tasks: { paused } })
  if (paused) for (const t of listTasks()) cancelTaskJobs(t.id)
  changed()
}
export function taskBusy(id: string): boolean {
  return !!getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, `task:${id}`), sql`${jobs.status} IN ('running','queued')`))
    .get()
}
/** null 表示新负载没有入队；调度器只能在真正接收后推进来源游标。 */
export function queueTriggeredTask(id: string, triggerInfo: Record<string, unknown>, delayed = false): string | null {
  const task = getTask(id)
  if (!task || !task.enabled || getSettings().tasks.paused) throw new Error('Task is paused or unavailable')
  if (taskBusy(id)) return null
  return enqueue('ai.task', { taskId: id, triggerInfo, delayed }, { dedupeKey: `task:${id}` })
}
export function queueTask(id: string, triggerInfo: Record<string, unknown> = { type: 'manual' }, delayed = false): string {
  const queued = queueTriggeredTask(id, triggerInfo, delayed)
  if (queued) return queued
  const active = getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, `task:${id}`), sql`${jobs.status} IN ('running','queued')`))
    .get()
  return active!.id
}
export async function parseTask(description: string): Promise<TaskInput> {
  const chat = getSettings().ai.chat
  if (!chat.providerId || !chat.model) throw new Error('Configure an AI model first')
  const { taskToolCatalog } = await import('./tools')
  const catalog = await taskToolCatalog(),
    zh = getSettings().language.startsWith('zh')
  return withRun({ purpose: 'task.parse', caller: 'app', perRun: perRunLimit() }, async () => {
    checkBudget()
    return structured({
      purpose: 'task.parse',
      providerId: chat.providerId!,
      model: quickModel(chat.providerId!, chat.model!),
      system: zh
        ? '把用户的一句话解析成任务四要素：触发、指令、勾选的只读工具、结果去向。name 简短。只从提供的工具名选择；不运行、不保存任务；不支持的对外动作写成需要用户确认的提醒。'
        : 'Parse a task into trigger, instruction, selected read tools and outputs. Choose only listed tool names. Do not run or save it; external actions require user review.',
      prompt: JSON.stringify({ description, tools: catalog.info.map((t) => t.name), language: getSettings().language }),
      schema: TaskSave.omit({ id: true }),
      guard: checkBudget
    })
  })
}
export function recipes() {
  const zh = getSettings().language.startsWith('zh')
  return taskRecipes
    .map((r) => ({ ...r, task: { ...r.task, name: zh ? r.name.zh : r.name.en, instruction: zh ? r.task.instruction : r.instructionEn } }))
}
export function todayTaskResults(): TodayTaskResult[] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return getDb()
    .select()
    .from(aiTaskRuns)
    .where(and(sql`${aiTaskRuns.startedAt} >= ${start.getTime()}`, eq(aiTaskRuns.status, 'ok')))
    .orderBy(desc(aiTaskRuns.startedAt))
    .all()
    .filter((r) => JSON.parse(r.resultRefs).some((x: { type: string }) => x.type === 'briefing'))
    .map((r) => ({ id: r.id, taskId: r.taskId, name: getTask(r.taskId)?.name ?? 'AI task', summary: r.summary ?? '', cost: r.cost }))
}
export function recoverTaskRuns(): void {
  getDb()
    .update(aiTaskRuns)
    .set({ status: 'canceled', endedAt: Date.now(), summary: 'Interrupted by application shutdown; not retried' })
    .where(eq(aiTaskRuns.status, 'running'))
    .run()
}
export function openTasksWindow(taskId: string): void {
  emit('nav:tasks', { taskId })
  app.focus({ steal: true })
}
export const ParseTaskDescription = z.string().trim().min(1).max(4000)
