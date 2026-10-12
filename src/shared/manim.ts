import { z } from 'zod'
import { compileExpression, GraphDataSchema } from './embeds/graph'

// 数学动画（v0.10 Manim 插件）：AI 只填模板参数，不写代码。
// 公式交给 LaTeX（先过滤危险命令）；函数在这里采样成点交给 Python，Python 端不解析任何表达式。

const text = (max: number) => z.string().trim().min(1).max(max)
const num = z.number().finite()
const range = z.tuple([num, num]).refine(([a, b]) => b > a, '范围的右端必须大于左端')

export const ANIMATION_KINDS = ['derivation', 'function-transform', 'number-line', 'geometry'] as const
export type AnimationKind = (typeof ANIMATION_KINDS)[number]

/** LaTeX 里只允许排版命令：禁止读写文件、改类别码、定义宏等 */
const TEX_BLOCK =
  /\\(input|include|openin|openout|read|write|immediate|catcode|def|edef|gdef|xdef|let|csname|newcommand|renewcommand|usepackage|documentclass|special|directlua|lua|jobname|loop|expandafter|futurelet|uccode|lccode|everypar|output|shipout|errmessage|message|show|tracing)/i
export const SafeTex = text(200).refine((s) => !TEX_BLOCK.test(s) && !/[^\\]?\^\^/.test(s), '公式里含有不允许的命令')

export const DerivationAnim = z.object({
  kind: z.literal('derivation'),
  /** 每步一个式子，相邻步骤做变形过渡 */
  steps: z
    .array(z.object({ tex: SafeTex, note: z.string().trim().max(40).optional() }))
    .min(2)
    .max(8)
})
export const FunctionTransformAnim = z.object({
  kind: z.literal('function-transform'),
  /** 起始函数 y = f(x)，语法同函数图 */
  base: text(120),
  transforms: z
    .array(
      z.object({
        kind: z.enum(['shift', 'scale', 'reflect']),
        axis: z.enum(['x', 'y']),
        /** shift：平移量；scale：倍数（不为 0）；reflect：忽略 */
        amount: num.default(1),
        label: z.string().trim().max(40).optional()
      })
    )
    .min(1)
    .max(4),
  xRange: range.default([-6, 6]),
  yRange: range.default([-4, 4])
})
export const NumberLineAnim = z.object({
  kind: z.literal('number-line'),
  range: range.default([-5, 5]),
  intervals: z
    .array(
      z.object({
        from: num.nullable(),
        to: num.nullable(),
        closedFrom: z.boolean().default(false),
        closedTo: z.boolean().default(false),
        label: z.string().trim().max(30).optional()
      })
    )
    .max(4)
    .default([]),
  points: z
    .array(z.object({ x: num, label: z.string().trim().max(20).optional() }))
    .max(8)
    .default([])
})
export const GeometryAnim = z.object({
  kind: z.literal('geometry'),
  /** 与几何图嵌入块相同的元素；按顺序逐个画出 */
  graph: GraphDataSchema.shape.graph
})
export const AnimationSchema = z.discriminatedUnion('kind', [DerivationAnim, FunctionTransformAnim, NumberLineAnim, GeometryAnim])
export type AnimationData = z.infer<typeof AnimationSchema>

/** 函数变换：逐级套用变换，返回每一级的表达式说明和采样点（给 Python 画图用） */
export function sampleTransforms(a: z.infer<typeof FunctionTransformAnim>, n = 240): { label: string; points: [number, number][] }[] {
  const base = compileExpression(a.base, ['x'])
  type F = (x: number) => number
  const stages: { label: string; f: F }[] = [{ label: `y = ${a.base}`, f: (x) => base({ x }) }]
  for (const tr of a.transforms) {
    const prev = stages[stages.length - 1].f
    const k = tr.amount
    let f: F
    if (tr.kind === 'shift') f = tr.axis === 'x' ? (x) => prev(x - k) : (x) => prev(x) + k
    else if (tr.kind === 'scale') {
      if (k === 0) throw new Error('伸缩倍数不能为 0')
      f = tr.axis === 'x' ? (x) => prev(x / k) : (x) => prev(x) * k
    } else f = tr.axis === 'x' ? (x) => -prev(x) : (x) => prev(-x)
    stages.push({ label: tr.label ?? describe(tr), f })
  }
  const [x0, x1] = a.xRange,
    [y0, y1] = a.yRange
  const pad = (y1 - y0) * 0.5
  return stages.map((s) => ({
    label: s.label,
    points: Array.from({ length: n + 1 }, (_, i) => {
      const x = x0 + ((x1 - x0) * i) / n
      const y = s.f(x)
      // 超出视窗太多或无定义的点截断到边缘外一点，避免竖线飞出画面
      return [x, Number.isFinite(y) ? Math.min(y1 + pad, Math.max(y0 - pad, y)) : NaN] as [number, number]
    })
  }))
}
function describe(t: z.infer<typeof FunctionTransformAnim>['transforms'][number]): string {
  if (t.kind === 'shift')
    return t.axis === 'x'
      ? `向${t.amount >= 0 ? '右' : '左'}平移 ${Math.abs(t.amount)}`
      : `向${t.amount >= 0 ? '上' : '下'}平移 ${Math.abs(t.amount)}`
  if (t.kind === 'scale') return t.axis === 'x' ? `横向伸缩 ${t.amount} 倍` : `纵向伸缩 ${t.amount} 倍`
  return t.axis === 'x' ? '关于 x 轴对称' : '关于 y 轴对称'
}

/** 语义检查：函数能解析、几何元素引用有效（与函数图嵌入块共用规则） */
export function checkAnimation(a: AnimationData): string | null {
  try {
    if (a.kind === 'function-transform') sampleTransforms(a, 8)
    if (a.kind === 'geometry') {
      if (a.graph.type !== 'geometry') return '几何作图只接受几何元素'
      const parsed = GraphDataSchema.safeParse({ graph: a.graph })
      if (!parsed.success) return '几何元素格式不正确'
    }
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** 笔记里的数学动画块：只存参数，视频按参数哈希缓存，可以随时重新生成 */
export const AnimationEmbedSchema = z.object({ title: z.string().trim().max(120).optional(), animation: AnimationSchema })
export type AnimationEmbed = z.infer<typeof AnimationEmbedSchema>
export function animationText(d: AnimationEmbed): string {
  const a = d.animation
  const body =
    a.kind === 'derivation'
      ? a.steps.map((s) => `${s.tex}${s.note ? `（${s.note}）` : ''}`).join(' → ')
      : a.kind === 'function-transform'
        ? [`y = ${a.base}`, ...a.transforms.map((t) => t.label ?? `${t.kind} ${t.axis} ${t.amount}`)].join(' → ')
        : a.kind === 'number-line'
          ? a.intervals.map((i) => i.label ?? `${i.from ?? '-∞'}~${i.to ?? '+∞'}`).join('，')
          : a.graph.type === 'geometry'
            ? a.graph.elements.map((e) => e.label ?? e.id).join('、')
            : ''
  return [d.title, body].filter(Boolean).join('\n')
}
/** 动画时长（秒）：按步骤数估计，4–20 秒 */
export function animationDuration(a: AnimationData): number {
  const n =
    a.kind === 'derivation'
      ? a.steps.length * 2.2
      : a.kind === 'function-transform'
        ? a.transforms.length * 2.6 + 2.4
        : a.kind === 'number-line'
          ? (a.intervals.length + a.points.length) * 1.8 + 1.2
          : (a.graph.type === 'geometry' ? a.graph.elements.length : 4) * 0.9 + 0.6
  return Math.min(20, Math.max(4, Math.round(n * 10) / 10))
}

/** 给模型看的模板说明（分镜提示词与助手工具共用） */
export const ANIMATION_GUIDE = [
  '数学动画（Manim）四种：',
  '- derivation：公式逐步推导。steps 为 2–8 步，每步 {tex: LaTeX 式子, note?: 一句说明}，相邻步骤会做变形过渡。',
  '- function-transform：函数平移伸缩。base 为 y=f(x) 的右边（如 x^2、sin(x)），transforms 为 1–4 步 {kind: shift|scale|reflect, axis: x|y, amount}，xRange/yRange 为坐标范围。',
  '- number-line：数轴与区间。range 为数轴范围，intervals 为区间 {from|null, to|null, closedFrom, closedTo, label?}，points 为标出的点。',
  '- geometry：几何作图。graph 与几何图相同（type: geometry，elements 为点、线段、圆、多边形等），按顺序逐个画出。',
  '只在动态过程有助于理解时使用；静态的公式或图用普通场景即可。'
].join('\n')

/** Manim 运行环境状态 */
export interface ManimStatus {
  state: 'unsupported' | 'missing' | 'installing' | 'ready' | 'error'
  /** 安装进度 0–1 与当前阶段 */
  progress: number
  phase: 'micromamba' | 'packages' | 'environment' | 'tex' | 'verify' | null
  /** 已装好的运行环境占用的磁盘字节 */
  bytes: number
  /** 首次下载预计大小（字节），按是否复用本机 LaTeX 计算 */
  estimate: number
  /** 本机已有满足要求的 LaTeX（可以不下载 TinyTeX） */
  systemTex: string | null
  tex: 'tinytex' | 'system' | null
  error: string | null
}
