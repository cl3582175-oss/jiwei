import { ChartBox } from '@/features/visuals/ChartBox'
import { DiagramBox, validateMermaid } from '@/features/visuals/DiagramBox'
import { TimelineBox } from '@/features/visuals/TimelineBox'
import { CodeStepsBox } from '@/features/visuals/CodeStepsBox'
import { useTokens } from '@/features/visuals/tokens'
import { useEffect, useMemo, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import { ChartDataSchema, DiagramDataSchema, InteractiveDataSchema, StepsDataSchema, TimelineDataSchema } from '@shared/embeds/visuals'
import { api } from '@/lib/utils'
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

export { useTokens } from '@/features/visuals/tokens'

const Broken = ({ text }: { text: string }) => (
  <div className="flex items-start gap-2 px-4 py-3 text-xs text-danger">
    <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
    <span className="break-all">{text}</span>
  </div>
)

function ChartView({ entry }: EmbedViewProps) {
  const data = useData(entry, ChartDataSchema)
  return data ? <ChartBox data={data} /> : <Broken text="chart" />
}
function DiagramView({ entry }: EmbedViewProps) {
  const data = useData(entry, DiagramDataSchema)
  return data ? <DiagramBox data={data} /> : <Broken text="diagram" />
}
function TimelineView({ entry }: EmbedViewProps) {
  const data = useData(entry, TimelineDataSchema)
  return data ? (
    <TimelineBox
      data={data}
      onAnchorClick={(anchor) => {
        if (anchor.type === 'segment') useApp.getState().setHighlight({ type: 'segment', id: anchor.id })
      }}
    />
  ) : (
    <Broken text="timeline" />
  )
}
function StepsView({ entry }: EmbedViewProps) {
  const data = useData(entry, StepsDataSchema)
  return data ? <CodeStepsBox data={data} /> : <Broken text="steps" />
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
