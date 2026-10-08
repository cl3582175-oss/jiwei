import { useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { HeatmapDay } from '@shared/types'
import { Tip } from '@/components/ui/primitives'

const CELL = 12
const GAP = 3

/** 0–4 级强度，按非零值的分位数切分，避免个别高峰把其他日子压成浅色 */
function levels(days: HeatmapDay[]): (d: number) => number {
  const vals = days
    .map((d) => d.count)
    .filter((c) => c > 0)
    .sort((a, b) => a - b)
  if (vals.length === 0) return () => 0
  const q = (p: number): number => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)]
  return (v) => (v <= 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4)
}

const LEVEL_BG = [
  'var(--heat-0)',
  'color-mix(in oklab, var(--accent) 28%, var(--heat-0))',
  'color-mix(in oklab, var(--accent) 52%, var(--heat-0))',
  'color-mix(in oklab, var(--accent) 76%, var(--heat-0))',
  'var(--accent)'
]

export function Heatmap({ days }: { days: HeatmapDay[] }) {
  const { t, i18n } = useTranslation()
  const level = useMemo(() => levels(days), [days])
  const scroller = useRef<HTMLDivElement>(null)
  // 空间不足时默认停在最近的日期（最右侧）
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [days])

  // 按周排列（周一为一周开始），首列前补空位
  const weeks = useMemo(() => {
    if (days.length === 0) return []
    const first = new Date(days[0].date + 'T00:00:00')
    const pad = (first.getDay() + 6) % 7
    const cells: (HeatmapDay | null)[] = [...Array(pad).fill(null), ...days]
    const out: (HeatmapDay | null)[][] = []
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7))
    return out
  }, [days])

  const monthFmt = new Intl.DateTimeFormat(i18n.language, { month: 'short' })
  const dateFmt = new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })

  return (
    <div>
      <div ref={scroller} className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col" style={{ gap: GAP }}>
          {/* 月份标签 */}
          <div className="relative h-4 text-2xs text-subtle">
            {weeks.map((w, i) => {
              const d = w.find(Boolean)
              if (!d) return null
              const date = new Date(d.date + 'T00:00:00')
              const prev = weeks[i - 1]?.find(Boolean)
              const newMonth = !prev || new Date(prev.date + 'T00:00:00').getMonth() !== date.getMonth()
              return newMonth && i < weeks.length - 2 ? (
                <span key={i} className="absolute" style={{ left: i * (CELL + GAP) }}>
                  {monthFmt.format(date)}
                </span>
              ) : null
            })}
          </div>
          <div className="flex" style={{ gap: GAP }}>
            {weeks.map((w, i) => (
              <div key={i} className="flex flex-col" style={{ gap: GAP }}>
                {w.map((d, j) =>
                  d ? (
                    <Tip
                      key={d.date}
                      side="top"
                      label={t('home.heatTip', { date: dateFmt.format(new Date(d.date + 'T00:00:00')), count: d.count })}
                    >
                      <div
                        className="rounded-[3px] transition-transform hover:scale-125"
                        style={{ width: CELL, height: CELL, background: LEVEL_BG[level(d.count)] }}
                      />
                    </Tip>
                  ) : (
                    <div key={j} style={{ width: CELL, height: CELL }} />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-2xs text-subtle">
        {t('home.heatmapLegendLess')}
        {LEVEL_BG.map((bg, i) => (
          <span key={i} className="rounded-[3px]" style={{ width: 10, height: 10, background: bg }} />
        ))}
        {t('home.heatmapLegendMore')}
      </div>
    </div>
  )
}
