const pad = (v: number): string => String(v).padStart(2, '0')
export function lensDate(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const dateString = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
function validDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? dateString(d) : null
}
/** 日历运算使用 UTC 的日期槽，避免夏令时和主机时区改变“几天后”。 */
export function relativeLensDate(phrase: string, base: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null
  const d = new Date(`${base}T00:00:00Z`)
  if (!Number.isFinite(d.getTime()) || dateString(d) !== base) return null
  const p = phrase
    .trim()
    .toLowerCase()
    .replace(/之前|以前|截止|截至|到期|为止/g, '')
    .replace(/^(?:before|by|on|the)\s+/, '')
    .trim()
  const absolute = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/.exec(p)
  if (absolute) return validDate(Number(absolute[1]), Number(absolute[2]), Number(absolute[3]))
  const add = (n: number): string => {
    const copy = new Date(d)
    copy.setUTCDate(copy.getUTCDate() + n)
    return dateString(copy)
  }
  if (/^(今天|今日|today)$/.test(p)) return add(0)
  if (/^(明天|明日|tomorrow)$/.test(p)) return add(1)
  if (/^(后天|day after tomorrow)$/.test(p)) return add(2)
  const days = /^(?:in\s+)?(\d{1,3})\s*(?:天后|days?)$/.exec(p)
  if (days) return add(Number(days[1]))
  if (/月底|月末|end of (?:this |next )?month/.test(p)) {
    const next = /下月|下个月|next month/.test(p)
    return dateString(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 + (next ? 1 : 0), 0)))
  }
  const cn = /^(下下|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(p)
  const en = /^(this |next |week after next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.exec(p)
  if (cn || en) {
    const day = cn
      ? Math.min('一二三四五六日天'.indexOf(cn[2]), 6)
      : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].indexOf(en![2])
    const prefix = cn?.[1] ?? en?.[1]?.trim() ?? '',
      offset = /下下|week after next/.test(prefix) ? 14 : /下|next/.test(prefix) ? 7 : 0
    let delta = day - ((d.getUTCDay() + 6) % 7) + offset
    if (!prefix && delta < 0) delta += 7
    return add(delta)
  }
  const numbered = /^(?:每月)?(\d{1,2})(?:号|日)$/.exec(p),
    md = /^(\d{1,2})月(\d{1,2})(?:日|号)?$/.exec(p)
  if (md) {
    const y = d.getUTCFullYear(),
      value = validDate(y, Number(md[1]), Number(md[2]))
    return value && value < base ? validDate(y + 1, Number(md[1]), Number(md[2])) : value
  }
  if (numbered) {
    const n = Number(numbered[1])
    if (n < 1 || n > 31) return null
    for (let m = 0; m < 13; m++) {
      const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1)),
        value = validDate(month.getUTCFullYear(), month.getUTCMonth() + 1, n)
      if (value && value >= base) return value
    }
  }
  return null
}
