import { readdir, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import log from 'electron-log/main'
import type { Trigger } from '@shared/tasks'
import { dayStart, localDay } from '@shared/plan'
import { getDb } from '../../db'
import { aiTasks, meta } from '../../db/schema'
import { getSettings } from '../settings'
import { getTask, listTasks, queueTriggeredTask, changed } from './service'
import { catchUpAt, nextTriggerAt, calendarTriggerDue } from './triggers'
import { events } from '../plan/calendar'
import { listGoals } from '../progress'
import * as mistakes from '../mistakes'
import { fetchWebText } from '../webText'
import { checkMailTriggers } from '../mail/scheduler'

interface TriggerState {
  files?: string[]
  webHash?: string
  lastCheck?: number
  seen?: string[]
  mistakeIds?: string[]
  scheduleAt?: number
}
const key = (id: string) => `task.trigger:${id}`
export function triggerState(id: string): TriggerState {
  try {
    return JSON.parse(
      getDb()
        .select()
        .from(meta)
        .where(eq(meta.key, key(id)))
        .get()?.value ?? '{}'
    )
  } catch {
    return {}
  }
}
export function writeTriggerState(id: string, state: TriggerState): void {
  const value = JSON.stringify(state)
  getDb()
    .insert(meta)
    .values({ key: key(id), value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .run()
}
export function clearTriggerState(id: string): void {
  getDb()
    .delete(meta)
    .where(eq(meta.key, key(id)))
    .run()
}
async function filesIn(path: string): Promise<string[]> {
  if (!isAbsolute(path) || (await stat(path)).isDirectory() !== true) throw new Error('Choose an existing absolute folder')
  const files = await readdir(path, { withFileTypes: true })
  if (files.length > 10000) throw new Error('Folder contains too many entries')
  return files
    .filter((f) => f.isFile())
    .map((f) => f.name)
    .sort()
}
export async function initializeTrigger(id: string, t: Trigger): Promise<void> {
  const state: TriggerState = {}
  if (t.type === 'folder') {
    state.files = await filesIn(t.path)
    state.lastCheck = Date.now()
  }
  writeTriggerState(id, state)
}
function scheduled(id: string, at: number, now: number, delayed: boolean): void {
  const t = getTask(id)
  if (!t) return
  const state = triggerState(id)
  if (state.scheduleAt === at) return
  if (!queueTriggeredTask(id, { type: t.trigger.type, dueAt: at }, delayed)) return
  writeTriggerState(id, { ...state, scheduleAt: at })
  getDb()
    .update(aiTasks)
    .set({ nextRunAt: nextTriggerAt(t.trigger, now), updatedAt: now })
    .where(eq(aiTasks.id, id))
    .run()
  changed()
}
export function catchUpTasks(now = Date.now()): void {
  if (getSettings().tasks.paused) return
  for (const t of listTasks().filter((t) => t.enabled)) {
    const at = catchUpAt(t.trigger, t.lastRunAt, now)
    if (at !== null) scheduled(t.id, at, now, true)
  }
}
let checking = false
export async function checkTasks(now = Date.now()): Promise<void> {
  if (checking || getSettings().tasks.paused) return
  checking = true
  try {
    await checkMailTriggers(now)
    for (const task of listTasks().filter((t) => t.enabled)) {
      try {
        const t = task.trigger,
          state = triggerState(task.id)
        if (t.type === 'schedule' || t.type === 'interval') {
          if (task.nextRunAt !== null && task.nextRunAt <= now) {
            const missed = catchUpAt(t, task.lastRunAt, now)
            if (t.type === 'schedule' && missed === null) {
              getDb()
                .update(aiTasks)
                .set({ nextRunAt: nextTriggerAt(t, now) })
                .where(eq(aiTasks.id, task.id))
                .run()
            } else scheduled(task.id, missed ?? task.nextRunAt, now, now - (missed ?? task.nextRunAt) > 60000)
          }
          continue
        }
        const seen = new Set(state.seen ?? []),
          today = localDay(now)
        if (t.type === 'calendar') {
          const after = Math.max(state.lastCheck ?? now - 60000, now - 86400000),
            upcoming = events({ startAt: after + t.minutesBefore * 60000, endAt: now + t.minutesBefore * 60000 + 1 }).filter(
            (e) =>
              e.status === 'planned' && (!t.kind || e.kind === t.kind) && calendarTriggerDue(e.startAt, t.minutesBefore, after, now)
          )
          const fresh = upcoming.filter((e) => !seen.has(`${e.id}:${e.startAt}`))
          if (fresh.length) {
            if (!queueTriggeredTask(task.id, {
              type: 'calendar',
              eventIds: fresh.map((e) => e.id),
              events: fresh.map((e) => ({ title: e.title, startAt: e.startAt, kind: e.kind }))
            })) continue
            for (const e of fresh) seen.add(`${e.id}:${e.startAt}`)
          }
          state.lastCheck = now
        } else if (t.type === 'deadline') {
          const gs = listGoals().filter(
            (g) =>
              g.status === 'active' &&
              g.targetAt !== null &&
              g.targetAt >= now &&
              dayStart(g.targetAt) <= dayStart(now) + t.days * 86400000 &&
              !seen.has(`${today}:${g.id}`)
          )
          if (gs.length) {
            if (!queueTriggeredTask(task.id, { type: 'deadline', goalIds: gs.map((g) => g.id) })) continue
            for (const g of gs) seen.add(`${today}:${g.id}`)
          }
        } else if (t.type === 'mistakes') {
          const ids = mistakes.list({}).map((m) => m.id),
            fresh = ids.filter((id) => !state.mistakeIds?.includes(id))
          if (fresh.length >= t.count) {
            if (!queueTriggeredTask(task.id, { type: 'mistakes', mistakeIds: fresh })) continue
            state.mistakeIds = ids
          }
        } else if (t.type === 'folder' && now - (state.lastCheck ?? 0) >= 5 * 60000) {
          const files = await filesIn(t.path),
            fresh = files.filter((f) => !state.files?.includes(f))
          if (state.files && fresh.length && !queueTriggeredTask(task.id, { type: 'folder', path: t.path, files: fresh })) continue
          state.files = files
          state.lastCheck = now
        } else if (t.type === 'web' && now - (state.lastCheck ?? 0) >= 6 * 3600000) {
          const page = await fetchWebText(t.url, t.selector),
            hash = createHash('sha256').update(page.text).digest('hex')
          if (state.webHash && state.webHash !== hash &&
            !queueTriggeredTask(task.id, { type: 'web', url: t.url, sourceUrls: page.sourceUrls, title: page.title, text: page.text.slice(0, 8000) })) continue
          state.webHash = hash
          state.lastCheck = now
        }
        state.seen = [...seen].slice(-500)
        writeTriggerState(task.id, state)
      } catch {
        log.warn('[tasks] trigger check failed', task.id)
      }
    }
  } finally {
    checking = false
  }
}
export async function initializeTaskScheduler(): Promise<void> {
  for (const t of listTasks())
    if (t.enabled && t.trigger.type === 'folder')
      try {
        await initializeTrigger(t.id, t.trigger)
      } catch {
        log.warn('[tasks] folder baseline unavailable', t.id)
      }
}
