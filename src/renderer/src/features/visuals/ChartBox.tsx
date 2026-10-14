import { useEffect, useMemo, useRef } from 'react'
import type { ChartData } from '@shared/embeds/visuals'
import { useTokens, type Tokens } from './tokens'
/*
 * 配色规则（v0.14 审查修订）：
 * - 分类色按 --viz-1…8 的固定顺序分配给系列，不循环、不按名次重排；
 * - 单系列柱 / 折线只用一种颜色（长度已经表达了大小，不再用颜色重复编码）；
 * - highlight 写了类目或系列名时，被点名的用强调色、其余退为灰色，并只给重点标数值。
 */
function chartOption(d: ChartData, c: Tokens, showTitle: boolean): Record<string, unknown> {
  const marks = d.highlight?.length ? new Set(d.highlight) : null
  const seriesMarked = !!marks && d.series.some((s) => marks.has(s.name))
  const catMarked = !!marks && (d.categories ?? []).some((cat) => marks.has(cat))
  const seriesColor = (i: number, name: string): string =>
    seriesMarked ? (marks!.has(name) ? (d.series.length === 1 ? c.viz[0] : c.viz[i % c.viz.length]) : c.rest) : c.viz[i % c.viz.length]
  const text = { color: c.muted, fontSize: 11 }
  const axis = {
    axisLine: { lineStyle: { color: c.borderStrong } },
    axisTick: { show: false },
    axisLabel: text,
    nameTextStyle: text,
    splitLine: { lineStyle: { color: c.border, opacity: 0.7 } }
  }
  const tooltip = {
    trigger: d.type === 'pie' || d.type === 'scatter' ? 'item' : 'axis',
    backgroundColor: c.surface,
    borderColor: c.border,
    textStyle: { color: c.fg, fontSize: 12 },
    axisPointer: {
      type: d.type === 'bar' ? 'shadow' : 'line',
      shadowStyle: { color: c.sunken, opacity: 0.6 },
      lineStyle: { color: c.borderStrong }
    }
  }
  const base = {
    color: c.viz,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'inherit' },
    title: showTitle && d.title ? { text: d.title, left: 'center', textStyle: { color: c.fg, fontSize: 13, fontWeight: 600 } } : undefined,
    tooltip,
    legend:
      d.series.length > 1 || d.type === 'pie'
        ? { bottom: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: text }
        : undefined,
    animationDuration: 500
  }
  const label = { show: true, color: c.fg, fontSize: 11, fontWeight: 600 }
  if (d.type === 'pie')
    return {
      ...base,
      series: [
        {
          type: 'pie',
          radius: ['40%', '68%'],
          center: ['50%', '46%'],
          itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 4 },
          label: { color: c.muted, formatter: '{b}  {d}%' },
          labelLine: { lineStyle: { color: c.borderStrong } },
          data: (d.categories ?? []).map((name, i) => ({
            name,
            value: d.series[0].data[i],
            ...(catMarked && !marks!.has(name) ? { itemStyle: { color: c.rest } } : {}),
            ...(catMarked && marks!.has(name) ? { label: { ...label, formatter: '{b}  {d}%' } } : {})
          }))
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
        axisLine: { lineStyle: { color: c.border } },
        splitArea: { show: false }
      },
      series: [
        {
          type: 'radar',
          symbolSize: 5,
          data: d.series.map((s, i) => {
            const color = seriesColor(i, s.name)
            return {
              name: s.name,
              value: s.data,
              itemStyle: { color },
              lineStyle: { color, width: 2 },
              areaStyle: { color, opacity: 0.12 }
            }
          })
        }
      ]
    }
  return {
    ...base,
    grid: {
      left: 48,
      right: 24,
      top: (showTitle && d.title ? 44 : 20) + (d.yLabel ? 16 : 0),
      bottom: d.series.length > 1 ? 48 : 32,
      containLabel: true
    },
    xAxis:
      d.type === 'scatter' ? { type: 'value', name: d.xLabel, ...axis } : { type: 'category', data: d.categories, name: d.xLabel, ...axis },
    yAxis: { type: 'value', name: d.yLabel, ...axis, axisLine: { show: false } },
    series: d.series.map((s, i) => {
      const color = seriesColor(i, s.name)
      // 按类目突出：被点名的类目用该系列的颜色并标数值，其余同系列的点退为灰色
      const data =
        catMarked && d.type !== 'scatter'
          ? s.data.map((v, k) =>
              marks!.has(d.categories![k])
                ? { value: v, itemStyle: { color: d.series.length === 1 ? c.emph : color }, label: { ...label, position: 'top' } }
                : // 单系列退为灰色；多系列保留系列色、调淡，免得认不出是哪个系列
                  { value: v, itemStyle: d.series.length === 1 ? { color: d.type === 'bar' ? c.rest : color } : { color, opacity: 0.35 } }
            )
          : s.data
      return {
        name: s.name,
        type: d.type,
        data,
        smooth: d.type === 'line',
        symbolSize: d.type === 'scatter' ? 9 : 6,
        barMaxWidth: 36,
        barGap: '12%',
        color,
        lineStyle: d.type === 'line' ? { width: 2, color } : undefined,
        itemStyle: d.type === 'bar' ? { borderRadius: [4, 4, 0, 0], color } : { color },
        emphasis: { focus: 'series' }
      }
    })
  }
}

/** showTitle=false：外面已有标题（组件框、笔记块标题）时不在图里重复 */
export function ChartBox({ data, showTitle = true }: { data: ChartData; showTitle?: boolean }) {
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
      chart.setOption(chartOption(d, c, showTitle))
      ro.observe(el.current)
    })
    return () => {
      disposed = true
      ro.disconnect()
      chart?.dispose()
    }
  }, [d, c, showTitle])
  return (
    <div>
      <div ref={el} className="chart-canvas h-[300px] w-full" />
      {d.note && <p className="px-4 pb-3 text-2xs text-subtle">{d.note}</p>}
    </div>
  )
}
