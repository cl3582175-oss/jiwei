import { z } from 'zod'

// 生成类富内容块的数据模型（v0.3.3）。原则：模型只输出“数据”，由成熟库负责呈现——
//   chart（ECharts）、diagram（Mermaid）、timeline、steps（代码分步讲解）、interactive（沙箱 HTML，仅强模型）。
// 数据刻意保持简单、可校验；每种都能转为纯文本，进入检索与 RAG。

const Anchor = z.object({ type: z.enum(['segment', 'block', 'source']), id: z.string().max(64) }).optional()

/* ——— 图表 ——— */

export const ChartDataSchema = z.object({
  type: z.enum(['bar', 'line', 'pie', 'scatter', 'radar']),
  title: z.string().max(120).optional(),
  /** 类目（柱状、折线、雷达的横轴 / 维度）；饼图用作扇区名 */
  categories: z.array(z.string().max(60)).max(60).optional(),
  series: z
    .array(
      z.object({
        name: z.string().max(60),
        /** 与 categories 一一对应的数值；散点图为 [x, y] 对 */
        data: z
          .array(z.union([z.number(), z.tuple([z.number(), z.number()])]))
          .min(1)
          .max(500)
      })
    )
    .min(1)
    .max(12),
  xLabel: z.string().max(40).optional(),
  yLabel: z.string().max(40).optional(),
  /** 数据出处说明 */
  note: z.string().max(300).optional(),
  anchor: Anchor
})
export type ChartData = z.infer<typeof ChartDataSchema>

export function chartText(d: ChartData): string {
  const lines = [
    d.title ?? '',
    ...(d.categories ?? []).map((c, i) => `${c}：${d.series.map((s) => `${s.name} ${JSON.stringify(s.data[i])}`).join('，')}`)
  ]
  if (!d.categories) lines.push(...d.series.map((s) => `${s.name}：${s.data.map((v) => JSON.stringify(v)).join(' ')}`))
  if (d.note) lines.push(d.note)
  return lines.filter(Boolean).join('\n')
}

/** 校验数据与类目数量是否一致（schema 之外的结构检查） */
export function checkChart(d: ChartData): string | null {
  if (d.type === 'scatter')
    return d.series.every((s) => s.data.every((v) => Array.isArray(v))) ? null : 'scatter 的 data 必须是 [x, y] 数对'
  if (!d.categories?.length) return `${d.type} 需要 categories`
  const bad = d.series.find((s) => s.data.length !== d.categories!.length)
  if (bad) return `系列“${bad.name}”有 ${bad.data.length} 个数值，但 categories 有 ${d.categories.length} 个`
  if (d.series.some((s) => s.data.some((v) => Array.isArray(v)))) return '只有 scatter 使用 [x, y] 数对'
  return null
}

/* ——— 图示（Mermaid） ——— */

export const DiagramDataSchema = z.object({
  /** Mermaid 源码（flowchart / sequenceDiagram / classDiagram / stateDiagram / erDiagram / gantt / journey / quadrantChart …） */
  code: z.string().min(5).max(12000),
  title: z.string().max(120).optional()
})
export type DiagramData = z.infer<typeof DiagramDataSchema>
export const diagramText = (d: DiagramData): string =>
  [d.title ?? '', d.code.replace(/[[\](){}<>|"]|-->|---|==>|-.->/g, ' ').replace(/\s+/g, ' ')].filter(Boolean).join('\n')

/* ——— 时间线 ——— */

export const TimelineDataSchema = z.object({
  title: z.string().max(120).optional(),
  events: z
    .array(
      z.object({
        /** 时间（自由文本：1885、1885 年、19 世纪末、第 3 周……） */
        date: z.string().min(1).max(40),
        title: z.string().min(1).max(120),
        detail: z.string().max(600).optional(),
        anchor: Anchor
      })
    )
    .min(2)
    .max(60)
})
export type TimelineData = z.infer<typeof TimelineDataSchema>
export const timelineText = (d: TimelineData): string =>
  [d.title ?? '', ...d.events.map((e) => `${e.date} ${e.title}${e.detail ? `：${e.detail}` : ''}`)].filter(Boolean).join('\n')

/* ——— 代码分步讲解 ——— */

export const StepsDataSchema = z.object({
  title: z.string().max(120).optional(),
  language: z.string().max(30),
  code: z.string().min(1).max(20000),
  steps: z
    .array(
      z.object({
        /** 本步高亮的行号（从 1 开始） */
        lines: z.array(z.number().int().min(1)).max(200),
        /** 本步讲解 */
        note: z.string().min(1).max(800),
        /** 本步之后的变量取值（可选，用于展示状态变化） */
        vars: z.record(z.string().max(40), z.string().max(200)).optional()
      })
    )
    .min(1)
    .max(60)
})
export type StepsData = z.infer<typeof StepsDataSchema>
export const stepsText = (d: StepsData): string =>
  [d.title ?? '', d.code, ...d.steps.map((s, i) => `${i + 1}. ${s.note}`)].filter(Boolean).join('\n')
export function checkSteps(d: StepsData): string | null {
  const n = d.code.split('\n').length
  const bad = d.steps.findIndex((s) => s.lines.some((l) => l > n))
  return bad >= 0 ? `第 ${bad + 1} 步引用了不存在的行（代码共 ${n} 行）` : null
}

/* ——— 交互演示（沙箱 HTML，仅强模型） ——— */

export const InteractiveDataSchema = z.object({
  title: z.string().min(1).max(120),
  /** 完整的单文件 HTML（内联 CSS / JS，不得访问网络） */
  html: z.string().min(20).max(200_000),
  /** 显示高度（像素） */
  height: z.number().int().min(160).max(1200).optional(),
  /** 演示说明（用于检索） */
  description: z.string().max(1000).optional()
})
export type InteractiveData = z.infer<typeof InteractiveDataSchema>
export const interactiveText = (d: InteractiveData): string => [d.title, d.description ?? ''].filter(Boolean).join('\n')
export function checkInteractive(d: InteractiveData): string | null {
  if (/<script[^>]+src=["']?https?:/i.test(d.html) || /<link[^>]+href=["']?https?:/i.test(d.html))
    return '不能引用外部脚本或样式，所有代码必须内联'
  if (/\bfetch\(|XMLHttpRequest|WebSocket\(/.test(d.html)) return '演示中不能访问网络'
  return null
}
