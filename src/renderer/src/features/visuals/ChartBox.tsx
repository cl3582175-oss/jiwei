import { useEffect, useMemo, useRef } from 'react'
import type { ChartData } from '@shared/embeds/visuals'
import { useTokens } from './tokens'
function chartOption(d: ChartData, c: Record<string, string>): Record<string, unknown> {
  const palette = [c.accent, c.p2, c.p3, c.p4, c.p5, c.p1]
  const text = { color: c.muted, fontSize: 11 }
  const axis = {
    axisLine: { lineStyle: { color: c.border } },
    axisLabel: text,
    splitLine: { lineStyle: { color: c.border, opacity: 0.6 } }
  }
  const base = {
    color: palette,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'inherit' },
    title: d.title ? { text: d.title, left: 'center', textStyle: { color: c.fg, fontSize: 13, fontWeight: 600 } } : undefined,
    tooltip: { trigger: d.type === 'pie' || d.type === 'scatter' ? 'item' : 'axis' },
    legend: d.series.length > 1 || d.type === 'pie' ? { bottom: 0, textStyle: text } : undefined,
    animationDuration: 500
  }
  if (d.type === 'pie')
    return {
      ...base,
      series: [
        {
          type: 'pie',
          radius: ['38%', '66%'],
          itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 4 },
          label: { color: c.muted },
          data: (d.categories ?? []).map((name, i) => ({ name, value: d.series[0].data[i] }))
        }
      ]
    }
  if (d.type === 'radar')
    return {
      ...base,
      radar: {
        indicator: (d.categories ?? []).map((name) => ({ name, max: Math.max(...d.series.flatMap((s) => s.data as number[])) * 1.1 })),
        axisName: { color: c.muted },
        splitLine: { lineStyle: { color: c.border } },
        splitArea: { show: false }
      },
      series: [{ type: 'radar', data: d.series.map((s) => ({ name: s.name, value: s.data, areaStyle: { opacity: 0.15 } })) }]
    }
  return {
    ...base,
    grid: { left: 48, right: 24, top: d.title ? 44 : 20, bottom: d.series.length > 1 ? 48 : 32, containLabel: true },
    xAxis:
      d.type === 'scatter' ? { type: 'value', name: d.xLabel, ...axis } : { type: 'category', data: d.categories, name: d.xLabel, ...axis },
    yAxis: { type: 'value', name: d.yLabel, ...axis },
    series: d.series.map((s) => ({
      name: s.name,
      type: d.type,
      data: s.data,
      smooth: d.type === 'line',
      barMaxWidth: 36,
      itemStyle: d.type === 'bar' ? { borderRadius: [4, 4, 0, 0] } : undefined
    }))
  }
}

export function ChartBox({ data }: { data: ChartData }) {
  const json = JSON.stringify(data)
  const d = useMemo(() => JSON.parse(json) as ChartData, [json])
  const c = useTokens()
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!d || !el.current) return
    let disposed = false
    let chart: { dispose(): void; resize(): void; setOption(o: unknown): void } | null = null
    const ro = new ResizeObserver(() => chart?.resize())
    void import('echarts').then((echarts) => {
      if (disposed || !el.current) return
      chart = echarts.init(el.current, undefined, { renderer: 'svg' })
      chart.setOption(chartOption(d, c))
      ro.observe(el.current)
    })
    return () => {
      disposed = true
      ro.disconnect()
      chart?.dispose()
    }
  }, [d, c])
  return (
    <div>
      <div ref={el} className="chart-canvas h-[300px] w-full" />
      {d.note && <p className="px-4 pb-3 text-2xs text-subtle">{d.note}</p>}
    </div>
  )
}
