import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Play, Pause, CircleAlert } from 'lucide-react'
import {
  ChartDataSchema,
  DiagramDataSchema,
  InteractiveDataSchema,
  StepsDataSchema,
  TimelineDataSchema,
  type ChartData,
  type StepsData
} from '@shared/embeds/visuals'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { registerEmbedView, type EmbedViewProps } from './registry'

// 生成类富内容块的显示组件：数据 → 成熟库渲染（ECharts、Mermaid、Shiki），统一跟随界面配色与深色模式。

function useData<T>(
  entry: EmbedViewProps['entry'],
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }
): T | null {
  const json = JSON.stringify((entry.get('data') as { toJSON(): unknown } | undefined)?.toJSON?.() ?? null)
  return useMemo(() => {
    const r = schema.safeParse(JSON.parse(json))
    return r.success ? r.data : null
  }, [json]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** 界面配色（随主题变化重新读取） */
/** 当前主题的颜色（图表、导图与掌握度地图使用） */
export function useTokens(): Record<string, string> {
  const [v, setV] = useState(0)
  useEffect(() => {
    const obs = new MutationObserver(() => setV((x) => x + 1))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] })
    return () => obs.disconnect()
  }, [])
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement)
    const g = (k: string, f: string): string => css.getPropertyValue(k).trim() || f
    return {
      accent: g('--accent', '#3d8a74'),
      fg: g('--fg', '#222'),
      muted: g('--muted', '#666'),
      subtle: g('--subtle', '#999'),
      border: g('--border', '#ddd'),
      surface: g('--surface', '#fff'),
      sunken: g('--sunken', '#f4f4f2'),
      danger: g('--danger', '#c0473a'),
      dark: document.documentElement.dataset.theme === 'dark' ? '1' : '',
      p1: g('--p-bamboo-ink', '#3f6b52'),
      p2: g('--p-apricot-ink', '#8a5a22'),
      p3: g('--p-sakura-ink', '#9a4b47'),
      p4: g('--p-sky-ink', '#3e6680'),
      p5: g('--p-lotus-ink', '#7a4f74')
    }
  }, [v]) // eslint-disable-line react-hooks/exhaustive-deps
}

const Broken = ({ text }: { text: string }) => (
  <div className="flex items-start gap-2 px-4 py-3 text-xs text-danger">
    <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
    <span className="break-all">{text}</span>
  </div>
)

/* ——— 图表（ECharts，SVG 渲染：清晰、可导出） ——— */

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

function ChartView({ entry }: EmbedViewProps) {
  const d = useData(entry, ChartDataSchema)
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
  if (!d) return <Broken text="chart" />
  return (
    <div>
      <div ref={el} className="chart-canvas h-[300px] w-full" />
      {d.note && <p className="px-4 pb-3 text-2xs text-subtle">{d.note}</p>}
    </div>
  )
}

/* ——— 图示（Mermaid） ——— */

let mermaidSeq = 0
async function loadMermaid(c: Record<string, string>) {
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // 纯 SVG 文字（不用 foreignObject）：导出时可以转成图片
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: 'base',
    fontFamily: 'inherit',
    themeVariables: {
      darkMode: !!c.dark,
      background: 'transparent',
      primaryColor: c.surface,
      primaryBorderColor: c.accent,
      primaryTextColor: c.fg,
      lineColor: c.muted,
      secondaryColor: c.sunken,
      tertiaryColor: c.sunken,
      textColor: c.fg,
      fontSize: '14px'
    }
  })
  return mermaid
}

/** 供主进程校验 AI 生成的 Mermaid（语法错误时把错误反馈给模型修正） */
export async function validateMermaid(code: string): Promise<string | null> {
  try {
    const m = await loadMermaid({ accent: '#000', fg: '#000', muted: '#666', surface: '#fff', sunken: '#eee' })
    await m.parse(code)
    return null
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 800) : String(e).slice(0, 800)
  }
}

function DiagramView({ entry }: EmbedViewProps) {
  const d = useData(entry, DiagramDataSchema)
  const c = useTokens()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!d) return
    let alive = true
    void (async () => {
      try {
        const m = await loadMermaid(c)
        const { svg } = await m.render(`mmd-${++mermaidSeq}`, d.code)
        if (alive) {
          setSvg(svg)
          setError(null)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [d, c])
  if (!d) return <Broken text="diagram" />
  if (error)
    return (
      <div>
        <Broken text={error} />
        <pre className="mx-4 mb-3 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-2xs text-muted">{d.code}</pre>
      </div>
    )
  return (
    <div className="diagram-svg flex justify-center overflow-x-auto px-4 py-3">
      {/* Mermaid securityLevel=strict 已清理输出 */}
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="h-24 w-full animate-pulse rounded bg-sunken" />}
    </div>
  )
}

/* ——— 时间线 ——— */

function TimelineView({ entry }: EmbedViewProps) {
  const d = useData(entry, TimelineDataSchema)
  if (!d) return <Broken text="timeline" />
  const open = (a: { type: string; id: string } | undefined): void => {
    if (!a) return
    const s = useApp.getState()
    if (a.type === 'segment') s.setHighlight({ type: 'segment', id: a.id })
  }
  return (
    <div className="px-5 py-4">
      {d.title && <p className="mb-3 text-center font-serif text-sm font-semibold text-fg">{d.title}</p>}
      <ol className="timeline">
        {d.events.map((e, i) => (
          <li key={i} className="timeline-item">
            <span className="timeline-date">{e.date}</span>
            <span className="timeline-dot" />
            <div className="min-w-0">
              <p
                className={cn('text-sm font-medium text-fg', e.anchor && 'cursor-pointer hover:text-accent')}
                onClick={() => open(e.anchor)}
              >
                {e.title}
              </p>
              {e.detail && <p className="mt-0.5 text-xs leading-relaxed text-muted">{e.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ——— 代码分步讲解（Shiki 高亮 + 步进播放） ——— */

function useHighlighted(d: StepsData | null, dark: boolean): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null)
  useEffect(() => {
    if (!d) return
    let alive = true
    void (async () => {
      try {
        const { codeToTokens } = await import('shiki')
        const r = await codeToTokens(d.code, { lang: d.language as never, theme: dark ? 'github-dark' : 'github-light' })
        const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        if (alive) setLines(r.tokens.map((line) => line.map((t) => `<span style="color:${t.color}">${esc(t.content)}</span>`).join('')))
      } catch {
        // 不认识的语言：不高亮
        if (alive) setLines(d.code.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')))
      }
    })()
    return () => {
      alive = false
    }
  }, [d, dark])
  return lines
}

function StepsView({ entry }: EmbedViewProps) {
  const { t } = useTranslation()
  const d = useData(entry, StepsDataSchema)
  const c = useTokens()
  const lines = useHighlighted(d, !!c.dark)
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing || !d) return
    const id = window.setInterval(() => setI((x) => (x + 1 < d.steps.length ? x + 1 : (setPlaying(false), x))), 2400)
    return () => window.clearInterval(id)
  }, [playing, d])
  if (!d) return <Broken text="steps" />
  const step = d.steps[Math.min(i, d.steps.length - 1)]
  const hl = new Set(step.lines)
  return (
    <div className="steps-view">
      {d.title && <p className="px-4 pt-3 font-serif text-sm font-semibold text-fg">{d.title}</p>}
      <pre className="steps-code">
        {(lines ?? d.code.split('\n')).map((l, n) => (
          <div key={n} className={cn('steps-line', hl.has(n + 1) && 'is-on')}>
            <span className="steps-ln">{n + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: lines ? l : l.replace(/&/g, '&amp;').replace(/</g, '&lt;') }} />
          </div>
        ))}
      </pre>
      <div className="flex items-start gap-3 border-t border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-2xs text-subtle">{t('embeds.stepOf', { n: i + 1, total: d.steps.length })}</p>
          <p className="mt-1 text-sm leading-relaxed text-fg">{step.note}</p>
          {step.vars && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(step.vars).map(([k, v]) => (
                <code key={k} className="rounded bg-sunken px-1.5 py-0.5 font-mono text-2xs text-muted">
                  {k} = {v}
                </code>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1" contentEditable={false}>
          <button className="embed-action" aria-label={t('embeds.prevStep')} disabled={i === 0} onClick={() => setI(i - 1)}>
            <ChevronLeft className="size-4" />
          </button>
          <button
            className="embed-action"
            aria-label={playing ? t('embeds.pause') : t('embeds.play')}
            onClick={() => (i >= d.steps.length - 1 ? (setI(0), setPlaying(true)) : setPlaying(!playing))}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <button className="embed-action" aria-label={t('embeds.nextStep')} disabled={i >= d.steps.length - 1} onClick={() => setI(i + 1)}>
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

/* ——— 交互演示（沙箱 iframe：不允许同源、不允许网络、不允许弹窗与表单提交） ——— */

/** 演示页面：注入配色变量与基础样式（CSP 由沙箱协议的响应头提供） */
export function sandboxDoc(html: string, c: Record<string, string>): string {
  const head = `<meta charset="utf-8"><style>:root{--accent:${c.accent};--fg:${c.fg};--muted:${c.muted};--border:${c.border};--surface:${c.surface};color-scheme:${c.dark ? 'dark' : 'light'}}html,body{margin:0;background:transparent;color:var(--fg);accent-color:var(--accent);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}</style>`
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + head)
    : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
}

function InteractiveView({ entry }: EmbedViewProps) {
  const d = useData(entry, InteractiveDataSchema)
  const c = useTokens()
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!d) return
    let alive = true
    void api.sandbox.register(sandboxDoc(d.html, c)).then((u) => alive && setSrc(u))
    return () => {
      alive = false
    }
  }, [d, c])
  if (!d) return <Broken text="interactive" />
  return (
    <div className="px-2 pb-2">
      {src ? (
        <iframe
          title={d.title}
          src={src}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{ height: d.height ?? 360 }}
          className="w-full rounded-lg border-0 bg-transparent"
        />
      ) : (
        <div style={{ height: d.height ?? 360 }} className="animate-pulse rounded-lg bg-sunken" />
      )}
    </div>
  )
}

registerEmbedView({ kind: 'chart', label: 'embeds.chart', View: ChartView })
registerEmbedView({ kind: 'diagram', label: 'embeds.diagram', View: DiagramView })
registerEmbedView({ kind: 'timeline', label: 'embeds.timeline', View: TimelineView })
registerEmbedView({ kind: 'steps', label: 'embeds.steps', View: StepsView })
registerEmbedView({ kind: 'interactive', label: 'embeds.interactive', View: InteractiveView })

// 主进程校验 AI 生成的数据时调用（见 main/services/ai/rendererValidate.ts）
declare global {
  interface Window {
    __jiweiValidate?: (kind: string, data: unknown) => Promise<string | null>
  }
}
window.__jiweiValidate = async (kind, data) => (kind === 'diagram' ? validateMermaid((data as { code: string }).code) : null)
