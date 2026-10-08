import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export const api = window.jiwei
export const isMac = window.platform.os === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

/** 相对时间：刚刚 / 5 分钟前 / 昨天 / 日期 */
export function formatRelative(ts: number, lang: string): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const diff = (ts - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 60) return rtf.format(Math.round(diff), 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', year: 'numeric' }).format(ts)
}

export function formatDate(ts: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', day: 'numeric' }).format(ts)
}

export function formatDateTime(ts: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ts)
}

/** 时间戳 → <input type="date"> 的本地日期值 */
export function toDateInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 日期输入值 → 时间戳，保留原时间戳的时分秒 */
export function fromDateInput(value: string, keepTimeFrom: number): number {
  const [y, m, d] = value.split('-').map(Number)
  const t = new Date(keepTimeFrom)
  return new Date(y, m - 1, d, t.getHours(), t.getMinutes(), t.getSeconds()).getTime()
}
