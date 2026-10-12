import { z } from 'zod'
import { AnimationSchema, checkAnimation } from './manim'
import type { PluginRegistryItem, PluginTemplate } from './plugins'
import { checkGraph } from './embeds/graph'

// 创作工坊（v0.9）：选题 → 素材 → 结构 → 起草 → 打磨 → 成品与回流。
// 第一批：图文长文（article）、课件 PPT（slides）、讲解视频（video，P4）。
// 素材在提示里编号为 M1、M2…，模型只能引用这些编号；每一节 / 每一页都记录用到的素材，导出时可溯源。

export const WORK_TYPES = ['article', 'slides', 'video'] as const
export type WorkType = (typeof WORK_TYPES)[number]
export const WORK_MODES = ['coach', 'cowrite', 'ghost'] as const
export type WorkMode = (typeof WORK_MODES)[number]
export const WORK_STAGES = ['topic', 'materials', 'outline', 'draft', 'polish', 'done'] as const
export type WorkStage = (typeof WORK_STAGES)[number]

const text = (max: number) => z.string().trim().min(1).max(max)
const refs = z
  .array(z.string().regex(/^M\d{1,2}$/))
  .max(8)
  .default([])

/* ——— 模型输出 ——— */

export const TopicDraft = z.object({
  topics: z
    .array(z.object({ title: text(80), angle: text(200), audience: text(40), why: text(200) }))
    .min(1)
    .max(5)
})

export const ArticleOutlineDraft = z.object({
  sections: z
    .array(z.object({ title: text(80), points: z.array(text(160)).min(1).max(6), sources: refs }))
    .min(2)
    .max(10)
})
export const SlidesOutlineDraft = z.object({
  slides: z
    .array(z.object({ title: text(60), bullets: z.array(text(120)).min(1).max(6), notes: z.string().max(600).default(''), sources: refs }))
    .min(3)
    .max(20)
})

/** 共写 / 代写：逐节正文（Markdown）；教练模式：只给提示问题，正文留给用户 */
export const ArticleSectionDraft = z.object({ body: z.string().max(6000) })
export const CoachDraft = z.object({ questions: z.array(text(200)).min(1).max(5), tips: z.array(text(200)).max(4).default([]) })
export const SlidesDraft = z.object({
  slides: z
    .array(z.object({ title: text(60), bullets: z.array(text(140)).min(1).max(6), notes: z.string().max(1200).default(''), sources: refs }))
    .min(3)
    .max(20)
})

export const PolishDraft = z.object({
  /** 受众视角挑刺 */
  audience: z.array(z.object({ part: z.number().int().min(0), issue: text(240), suggestion: z.string().max(300).default('') })).max(10),
  /** 逐条核对：没有出处或与素材不一致的句子 */
  facts: z
    .array(
      z.object({
        part: z.number().int().min(0),
        quote: text(240),
        verdict: z.enum(['unsupported', 'contradicted']),
        source: z
          .string()
          .regex(/^M\d{1,2}$/)
          .optional(),
        note: z.string().max(240).default('')
      })
    )
    .max(12),
  /** 讲不清的地方：可以一键生成复习卡片 */
  unclear: z.array(z.object({ part: z.number().int().min(0), point: text(200), question: text(200) })).max(8)
})
export type PolishResult = z.infer<typeof PolishDraft>

/* ——— 存储 ——— */

export interface ArticlePart {
  id: string
  title: string
  points: string[]
  sources: string[]
  body: string
  /** 教练模式：给用户的提示问题 */
  coach?: { questions: string[]; tips: string[] }
}
export interface SlidePart {
  id: string
  title: string
  bullets: string[]
  notes: string
  sources: string[]
}
/* ——— 讲解视频（P4）：分镜 = 场景模板 + 参数 + 旁白；渲染器按时间驱动动画，逐帧录制 ——— */

export const SCENE_TEMPLATES = [
  'title',
  'bullets',
  'formula',
  'diagram',
  'chart',
  'graph',
  'compare',
  'quote',
  'summary',
  'animation'
] as const
export type SceneTemplate = (typeof SCENE_TEMPLATES)[number]

const sceneBase = {
  title: z.string().trim().max(60).default(''),
  /** 旁白：按它合成配音并切分字幕；场景时长跟随旁白 */
  narration: z.string().trim().min(1).max(400),
  sources: refs
}
export const SceneDraft = z.discriminatedUnion('template', [
  z.object({ template: z.literal('title'), subtitle: z.string().max(80).default(''), ...sceneBase }),
  z.object({ template: z.literal('bullets'), items: z.array(text(60)).min(1).max(5), ...sceneBase }),
  /** 公式逐步推导：每步一个 LaTeX 式子 */
  z.object({ template: z.literal('formula'), steps: z.array(text(200)).min(1).max(6), ...sceneBase }),
  /** Mermaid 图示（flowchart 等） */
  z.object({ template: z.literal('diagram'), code: z.string().min(5).max(3000), ...sceneBase }),
  z.object({
    template: z.literal('chart'),
    kind: z.enum(['bar', 'line', 'pie']),
    categories: z.array(text(20)).min(2).max(10),
    series: z
      .array(z.object({ name: text(20), data: z.array(z.number()).min(2).max(10) }))
      .min(1)
      .max(3),
    ...sceneBase
  }),
  /** 函数图：一个或几个 y = f(x)，语法同 graph 嵌入块 */
  z.object({
    template: z.literal('graph'),
    functions: z.array(text(120)).min(1).max(3),
    view: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([-6, 6, -4, 4]),
    ...sceneBase
  }),
  z.object({
    template: z.literal('compare'),
    left: z.object({ title: text(30), items: z.array(text(50)).min(1).max(4) }),
    right: z.object({ title: text(30), items: z.array(text(50)).min(1).max(4) }),
    ...sceneBase
  }),
  z.object({ template: z.literal('quote'), quote: text(160), by: z.string().max(60).default(''), ...sceneBase }),
  z.object({ template: z.literal('summary'), items: z.array(text(60)).min(1).max(5), ...sceneBase }),
  /** 数学动画（v0.10，需要 Manim 插件）：渲染视频时生成片段；没装或失败时换成普通场景 */
  z.object({ template: z.literal('animation'), animation: AnimationSchema, ...sceneBase })
])
export type SceneData = z.infer<typeof SceneDraft>
export type VideoScene = SceneData & { id: string }
export const StoryboardDraft = z.object({ scenes: z.array(SceneDraft).min(3).max(14) })

export const VideoVoiceSchema = z.object({
  /** local：本机 AI 语音；ai：云端语音合成；none：不配音，只有字幕 */
  engine: z.enum(['local', 'ai', 'none']),
  providerId: z.string().max(64).nullable().default(null),
  voice: z.string().max(40).nullable().default(null)
})
export type VideoVoice = z.infer<typeof VideoVoiceSchema>

export type WorkParts =
  | { kind: 'article'; parts: ArticlePart[] }
  | { kind: 'slides'; parts: SlidePart[] }
  | { kind: 'video'; parts: VideoScene[]; voice: VideoVoice }

/** 分镜的语义校验：函数图表达式可解析、图表数据与类别对齐；返回错误说明或 null */
export function checkScene(s: SceneData): string | null {
  if (s.template === 'animation') return checkAnimation(s.animation)
  if (s.template === 'graph')
    for (const expr of s.functions) {
      const err = checkGraph({ graph: { type: 'function', functions: [{ expr }], params: [], view: s.view } })
      if (err) return err
    }
  if (s.template === 'chart' && s.series.some((x) => x.data.length !== s.categories.length)) return 'chart data must match categories'
  return null
}

/** 数学动画用不了时（没装 Manim、渲染失败）换成画面最接近的普通场景，旁白不变 */
export function animationFallback(s: Extract<SceneData, { template: 'animation' }>): SceneData {
  const base = { title: s.title, narration: s.narration, sources: s.sources }
  const a = s.animation
  if (a.kind === 'derivation') return { ...base, template: 'formula', steps: a.steps.slice(0, 6).map((x) => x.tex) }
  if (a.kind === 'function-transform')
    return { ...base, template: 'graph', functions: [a.base], view: [a.xRange[0], a.xRange[1], a.yRange[0], a.yRange[1]] }
  if (a.kind === 'number-line') {
    const items = [
      ...a.intervals.map((iv) => iv.label || `${iv.closedFrom ? '[' : '('}${iv.from ?? '-∞'}, ${iv.to ?? '+∞'}${iv.closedTo ? ']' : ')'}`),
      ...a.points.flatMap((p) => (p.label ? [`${p.label}：${p.x}`] : []))
    ].slice(0, 5)
    if (items.length) return { ...base, template: 'bullets', items }
  }
  return { ...base, template: 'title', subtitle: '' }
}

/** 旁白按句切分，按字数比例分配到配音时长内 */
export function sceneCaptions(narration: string, start: number, spoken: number): { start: number; end: number; text: string }[] {
  const sentences = (narration.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [narration]).map((s) => s.trim()).filter(Boolean)
  // 太长的句子再按逗号切，避免一行字幕过长
  const pieces = sentences.flatMap((s) =>
    s.length <= 28
      ? [s]
      : s.split(/(?<=[，,、])/).reduce<string[]>((acc, x) => {
          if (acc.length && (acc[acc.length - 1] + x).length <= 28) acc[acc.length - 1] += x
          else acc.push(x)
          return acc
        }, [])
  )
  const total = pieces.reduce((n, p) => n + p.length, 0) || 1
  let at = start
  return pieces.map((text) => {
    const d = (spoken * text.length) / total
    const c = { start: at, end: at + d, text: text.replace(/[，,、；;]$/, '') }
    at += d
    return c
  })
}

/** 渲染进度 / 结果（作品页显示） */
export interface VideoRender {
  status: 'idle' | 'running' | 'done' | 'error'
  progress: number
  stage: string | null
  message: string | null
  file: string | null
}

export interface WorkMaterial {
  id: string
  /** 提示里的编号 M1… */
  ref: string
  refType: 'note' | 'source'
  refId: string
  ownerId: string
  title: string
  excerpt: string
  used: boolean
  available?: boolean
}

export interface WorkExport {
  format: 'md' | 'docx' | 'pdf' | 'pptx' | 'mp4' | 'srt' | 'json'
  path: string
  at: number
}

export interface Work {
  id: string
  type: WorkType
  title: string
  topic: string
  audience: string
  mode: WorkMode
  stage: WorkStage
  goalId: string | null
  template?: PluginRegistryItem<PluginTemplate> | null
  content: WorkParts | null
  polish: PolishResult | null
  exports: WorkExport[]
  publishedWhere: string | null
  publishedAt: number | null
  retrospective: string | null
  createdAt: number
  updatedAt: number
  materials: WorkMaterial[]
}

export const WorkCreateSchema = z.object({
  templateId: z.string().max(257).optional(),
  type: z.enum(WORK_TYPES),
  title: z.string().trim().max(120).default(''),
  topic: z.string().trim().max(500).default(''),
  audience: z.string().trim().max(60).default(''),
  mode: z.enum(WORK_MODES),
  goalId: z.string().max(64).nullable().default(null)
})
export type WorkCreate = z.input<typeof WorkCreateSchema>

export const WorkUpdateSchema = z.object({
  id: z.string().max(64),
  title: z.string().trim().max(120).optional(),
  topic: z.string().trim().max(500).optional(),
  audience: z.string().trim().max(60).optional(),
  mode: z.enum(WORK_MODES).optional(),
  stage: z.enum(WORK_STAGES).optional(),
  content: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('article'),
        parts: z
          .array(
            z.object({
              id: z.string().max(40),
              title: z.string().max(120),
              points: z.array(z.string().max(300)).max(10),
              sources: z.array(z.string().max(8)).max(12),
              body: z.string().max(20000),
              coach: z.object({ questions: z.array(z.string().max(300)).max(8), tips: z.array(z.string().max(300)).max(8) }).optional()
            })
          )
          .max(30)
      }),
      z.object({
        kind: z.literal('slides'),
        parts: z
          .array(
            z.object({
              id: z.string().max(40),
              title: z.string().max(120),
              bullets: z.array(z.string().max(300)).max(10),
              notes: z.string().max(3000),
              sources: z.array(z.string().max(8)).max(12)
            })
          )
          .max(40)
      }),
      z.object({
        kind: z.literal('video'),
        parts: z.array(z.intersection(SceneDraft, z.object({ id: z.string().max(40) }))).max(20),
        voice: VideoVoiceSchema
      })
    ])
    .optional(),
  publishedWhere: z.string().max(300).nullable().optional(),
  retrospective: z.string().max(2000).nullable().optional()
})
export type WorkUpdate = z.input<typeof WorkUpdateSchema>

/** 提示里的素材编号 */
export const materialRef = (i: number): string => `M${i + 1}`
