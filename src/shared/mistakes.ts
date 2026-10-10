import { z } from 'zod'
import type { AnswerCheck } from './types'

export const MistakeSubjectSchema = z.enum(['math', 'physics', 'chemistry', 'english', 'other'])
export const MistakeCauseSchema = z.enum(['concept', 'calculation', 'reading', 'method', 'careless', 'unknown'])
export const MistakeSourceSchema = z.enum(['inbox', 'capture', 'browser', 'manual'])
export type MistakeSubject = z.infer<typeof MistakeSubjectSchema>
export type MistakeCause = z.infer<typeof MistakeCauseSchema>
export type MistakeSource = z.infer<typeof MistakeSourceSchema>
export const MistakeId = z.string().uuid()
const AssetId = z.string().regex(/^[0-9a-f]{64}$/)
const Text = z.string().max(12_000)

export const MistakeCreateSchema = z.object({
  sourceKind: MistakeSourceSchema.default('manual'),
  sourceRef: z.string().max(4096).nullable().optional(),
  assetId: AssetId.nullable().optional(),
  text: Text.default(''),
  /** 重试同一次操作时沿用请求身份；不是文件名。 */
  requestId: MistakeId.optional(),
  /** 只允许进一步限制发送，不能由 renderer 解除服务端隐私限制。 */
  localOnly: z.boolean().optional()
}).refine((v) => !!v.assetId || !!v.text.trim(), 'Image or question required')
export type MistakeCreate = z.infer<typeof MistakeCreateSchema>
export const MistakePatchSchema = z.object({
  question: Text.optional(),
  myAnswer: Text.optional(),
  correctAnswer: Text.optional(),
  solution: Text.optional(),
  subject: MistakeSubjectSchema.optional(),
  cause: MistakeCauseSchema.optional(),
  causeReason: z.string().max(1000).optional(),
  concepts: z.array(z.string().trim().min(1).max(40)).max(3).optional(),
  verified: z.boolean().optional()
})
export type MistakePatch = z.infer<typeof MistakePatchSchema>
export const MistakeFiltersSchema = z.object({
  subject: MistakeSubjectSchema.optional(),
  cause: MistakeCauseSchema.optional(),
  concept: z.string().max(40).optional(),
  verified: z.boolean().optional(),
  since: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(),
  search: z.string().max(500).optional()
}).optional()
export type MistakeFilters = z.infer<typeof MistakeFiltersSchema>

export const MistakeSplitSchema = z.object({
  questions: z.array(z.object({
    question: Text.trim().min(1),
    myAnswer: Text,
    correctAnswer: Text,
    solution: Text,
    subject: MistakeSubjectSchema,
    /** 原件上这题被批改为正确（✓、对勾、满分）。一张卷子里只收做错的题。 */
    markedCorrect: z.boolean().default(false),
    regions: z.array(z.number().int().min(0).max(9999)).max(200)
  })).min(1).max(20)
})
export type MistakeSplit = z.infer<typeof MistakeSplitSchema>['questions'][number]
export const MistakeDiagnosisSchema = z.object({
  cause: MistakeCauseSchema,
  reason: z.string().max(1000),
  /** 引用我的答案中的原文，服务端检查后才能接受非 unknown。 */
  evidence: z.string().max(1000),
  concepts: z.array(z.string().trim().min(1).max(40)).min(1).max(3)
})
export type MistakeDiagnosis = z.infer<typeof MistakeDiagnosisSchema>
export const MistakeSolveSchema = z.object({ answer: Text.trim().min(1), solution: Text.trim().min(1) })
export const MistakeVariantSchema = z.object({
  question: Text.trim().min(1), answer: Text.trim().min(1), solution: Text.trim().min(1),
  /** 能数值检验时给出最终数值；不能时为 null。 */
  numericAnswer: z.number().finite().nullable(),
  unit: z.string().max(80)
})
export type GeneratedVariant = z.infer<typeof MistakeVariantSchema>
export const MistakeIndependentSchema = z.object({ answer: Text.trim().min(1), numericAnswer: z.number().finite().nullable(), unit: z.string().max(80) })
export const MistakePracticeAnswerSchema = z.string().trim().min(1).max(3000)

export type MistakeFlag = 'processing' | 'needs-recognition' | 'recognition-uncertain' | 'no-model' | 'local-only' | 'canceled' | 'failed'
export interface Mistake {
  id: string
  noteId: string | null
  rowId: string | null
  sourceKind: MistakeSource
  sourceRef: string | null
  assetId: string | null
  cropAssetId: string | null
  imageUrl: string | null
  originalImageUrl: string | null
  question: string
  myAnswer: string
  correctAnswer: string
  solution: string
  answerOrigin: 'image' | 'ai' | 'user'
  verified: boolean
  cause: MistakeCause
  causeReason: string
  concepts: string[]
  subject: MistakeSubject
  flags: MistakeFlag[]
  diagnosisCorrection: boolean
  ingestKey: string | null
  createdAt: number
  updatedAt: number
  /** 提案应用后才算进入复习。 */
  landed: boolean
}
export interface MistakeIngestion { jobId: string | null; items: Mistake[] }
export interface MistakeLanding { mistakeId: string; noteId: string; proposalId: string | null; deleting?: boolean; moving?: boolean }
export interface MistakeVariant {
  id: string
  mistakeId: string
  question: string
  answer: string
  solution: string
  createdAt: number
  usedAt: number | null
  flagged: boolean
  model: string | null
}
export type VariantFallback = 'empty' | 'no-model' | 'local-only' | 'flagged' | 'unverified' | null
export interface MistakePractice {
  mistakeId: string
  variantId: string | null
  question: string
  answer: string
  solution: string
  original: { question: string; answer: string }
  fallback: VariantFallback
}
export interface MistakeVariantStats { generated: number; discarded: number; accepted: number; ratio: number }
export interface MistakeApi {
  create(input: MistakeCreate): Promise<MistakeIngestion>
  get(id: string): Promise<Mistake | null>
  list(filters?: MistakeFilters): Promise<Mistake[]>
  update(id: string, patch: MistakePatch): Promise<Mistake>
  retry(id: string): Promise<MistakeIngestion>
  prepare(id: string): Promise<MistakeLanding>
  complete(id: string, proposalId: string, update: Uint8Array): Promise<Mistake>
  remove(id: string): Promise<MistakeLanding | null>
  removeComplete(id: string, proposalId: string, update: Uint8Array): Promise<void>
  practice(id: string): Promise<MistakePractice>
  replenish(id: string, immediate?: boolean): Promise<string | null>
  flag(variantId: string): Promise<MistakePractice>
  check(id: string, variantId: string | null, answer: string): Promise<AnswerCheck>
  useVariant(variantId: string): Promise<void>
  variants(id: string): Promise<MistakeVariant[]>
  variantStats(): Promise<MistakeVariantStats>
}
