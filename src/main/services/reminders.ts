import { getMainWindow } from '../mainWindow'
import { checkIcs } from './plan/ics'
import { checkPlan } from './plan/schedule'
import { checkTasks } from './tasks/scheduler'
import { checkDiscover } from './discover/daily'
import { checkPodcast } from './discover/podcast'
import { checkInboxSchedule } from './inbox'
import { Notification } from 'electron'
import log from 'electron-log/main'
import { emit } from '../events'
import { getSettings } from './settings'
import { getMeta, setMeta } from './memory'
import { reflectionOverview, startOfDay } from './reflection'

// 复盘提醒：到了设置的时间（默认 21:00），当天的微复盘还没做 → 系统通知；每周复盘在设定的那一天提醒。
// 每天 / 每周只提醒一次（记在个人数据库），点击通知打开复盘页。

let timer: NodeJS.Timeout | null = null

const dayKey = (t = Date.now()): string => new Date(startOfDay(t)).toISOString().slice(0, 10)

function notify(kind: 'daily' | 'weekly', title: string, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    const w = getMainWindow()
    if (w) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
    emit('nav:reflect', { kind })
  })
  n.show()
}

export function checkReminders(now = new Date()): void {
  void checkTasks(now.getTime()).catch(() => log.warn('[tasks] scheduler check failed'))
  checkPlan(now.getTime())
  checkIcs(now.getTime())
  checkInboxSchedule(now)
  checkDiscover(now.getTime())
  checkPodcast(now.getTime())
  const s = getSettings()
  const r = s.reflection
  const [h, m] = r.time.split(':').map(Number)
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return
  const zh = s.language.startsWith('zh')
  const o = reflectionOverview()
  const today = dayKey(now.getTime())
  if (r.daily && o.today?.status !== 'done' && getMeta('remindedDaily') !== today) {
    setMeta('remindedDaily', today)
    notify('daily', zh ? '1 分钟微复盘' : 'One-minute reflection', zh ? '今天学了什么？还有什么没想明白？' : 'What did you learn today? What is still unclear?')
  }
  if (r.weekly && now.getDay() === r.weeklyDay && o.week?.status !== 'done' && getMeta('remindedWeekly') !== today) {
    setMeta('remindedWeekly', today)
    notify('weekly', zh ? '本周复盘' : 'Weekly review', zh ? '花十分钟回顾这一周：目标、结果、原因、下一步。' : 'Take ten minutes to look back on your week.')
  }
}

export function startReminders(): void {
  const tick = (): void => {
    try {
      checkReminders()
    } catch (e) {
      log.warn('[reminders] check failed', e)
    }
  }
  setTimeout(tick, 20_000)
  timer = setInterval(tick, 60_000)
}

export function stopReminders(): void {
  if (timer) clearInterval(timer)
  timer = null
}
