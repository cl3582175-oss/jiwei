import { addDays, dayStart, localDay, type ReviewForecast } from '@shared/plan'

/** 只统计已排期的下限，不模拟用户未来评分后的 FSRS 再次到期。 */
export function forecastCards(
  rows: { due: number; state: number; suspended: boolean }[],
  days: number,
  newPerDay: number,
  now = Date.now()
): ReviewForecast[] {
  const start = dayStart(now)
  let remaining = rows.filter((r) => !r.suspended && r.state === 0).length
  return Array.from({ length: days }, (_, i) => {
    const at = addDays(start, i),
      end = addDays(at, 1)
    const due = rows.filter((r) => !r.suspended && r.state !== 0 && r.due < end && (i === 0 || r.due >= at)).length
    const fresh = Math.min(remaining, newPerDay)
    remaining -= fresh
    return { date: localDay(at), due, new: fresh }
  })
}
