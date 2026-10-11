import { z } from 'zod'

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
export type WorkParts = { kind: 'article'; parts: ArticlePart[] } | { kind: 'slides'; parts: SlidePart[] }

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
      })
    ])
    .optional(),
  publishedWhere: z.string().max(300).nullable().optional(),
  retrospective: z.string().max(2000).nullable().optional()
})
export type WorkUpdate = z.input<typeof WorkUpdateSchema>

/** 提示里的素材编号 */
export const materialRef = (i: number): string => `M${i + 1}`
