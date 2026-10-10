/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { z } from 'zod'

export const READING_STYLE_VERSION = 'faithful-v3'
export const READING_MAX_PARAGRAPHS = 20
export const READING_MAX_CHARACTERS = 3000
export const READING_CACHE_BYTES = 50 * 1024 * 1024
export const JIWEI_UI_ATTRIBUTE = 'data-jiwei-ui'
export { readingLanguage, isForeignText, normalizedReadingText, readingParts, readingBatches, readingParagraphs, originalReadingText, originalRangeText, READING_PARAGRAPH_SELECTOR } from './readingText'

export const ReadingModeSchema = z.enum(['original', 'parallel', 'translation'])
export type ReadingMode = z.infer<typeof ReadingModeSchema>
export const ReadingTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('browser'), id: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('source'), id: z.string().min(1).max(100) })
])
export type ReadingTarget = z.infer<typeof ReadingTargetSchema>
export const ThresholdSchema = z.number().int().min(1000).max(50000)
export const WordSchema = z.string().trim().min(1).max(100).regex(/^[\p{L}][\p{L}'’ -]*$/u)
export const ReadingConfigureSchema = z.object({
  target: ReadingTargetSchema,
  mode: ReadingModeSchema,
  annotations: z.boolean(),
  skipCostPrompt: z.boolean().optional(),
  initialThreshold: ThresholdSchema.optional()
})
export type ReadingConfigure = z.infer<typeof ReadingConfigureSchema>
export const ReadingParagraphSchema = z.object({ id: z.string().min(1).max(140), text: z.string().trim().min(1).max(READING_MAX_CHARACTERS) })
export type ReadingParagraph = z.infer<typeof ReadingParagraphSchema>
export const ReadingBatchSchema = z.object({
  target: ReadingTargetSchema,
  paragraphs: z.array(ReadingParagraphSchema).min(1).max(READING_MAX_PARAGRAPHS),
  translation: z.boolean(),
  annotations: z.boolean(),
  targetLanguage: z.string().min(2).max(20)
}).superRefine((input, ctx) => {
  if (input.paragraphs.reduce((n, p) => n + p.text.length, 0) > READING_MAX_CHARACTERS)
    ctx.addIssue({ code: 'custom', path: ['paragraphs'], message: 'Reading batch exceeds 3000 characters' })
  if (new Set(input.paragraphs.map((p) => p.id)).size !== input.paragraphs.length)
    ctx.addIssue({ code: 'custom', path: ['paragraphs'], message: 'Duplicate paragraph id' })
})
export type ReadingBatch = z.infer<typeof ReadingBatchSchema>
export const ReadingAnnotationSchema = z.object({ word: z.string().min(1).max(100), gloss: z.string().min(1).max(12) })
export type ReadingAnnotation = z.infer<typeof ReadingAnnotationSchema>
/** 模型输出的宽松契约：释义偏长或多给几个词时由服务端裁剪，不让整批译文失败（v0.6.5 实测：维基长条目因此反复报错）。 */
export const ReadingOutputSchema = z.object({
  paragraphs: z.array(z.object({
    id: z.string().min(1).max(140), translation: z.string().max(12000),
    annotations: z.array(z.object({ word: z.string().min(1).max(100), gloss: z.string().max(200) })).max(40)
  })).max(READING_MAX_PARAGRAPHS)
})
/** 每段最多注释的生词数：只挑最生僻的几个，正文不被注释淹没。 */
export const READING_MAX_GLOSSES = 4
/** 词汇水平档位 → 词频表排名阈值。词频表来自影视字幕语料，学术常用词排名偏后，所以排名阈值约为词汇量的两倍。 */
export const VOCAB_LEVELS = [
  { id: 'cet4', threshold: 8000 },
  { id: 'cet6', threshold: 12000 },
  { id: 'ielts', threshold: 16000 },
  { id: 'advanced', threshold: 24000 }
] as const
export const DEFAULT_VOCAB_THRESHOLD = 12000
/** 模型给的释义规整成简短中文：取第一个义项，去掉括注。 */
export function shortGloss(raw: string): string | null {
  const first = raw.replace(/[（(][^）)]*[）)]/g, '').split(/[；;，,、/|。]/)[0]?.trim() ?? ''
  return /^[\p{Script=Han}…·]{1,12}$/u.test(first) ? first : null
}
export type ReadingOutput = z.infer<typeof ReadingOutputSchema>
export interface ReadingResult { id: string; translation: string; annotations: ReadingAnnotation[]; cached: boolean }
export interface ReadingBatchResult { paragraphs: ReadingResult[]; model: string; characters: number; estimatedCost: number | null }
export interface ReadingState { language: string; foreign: boolean; mode: ReadingMode; annotations: boolean; skipCostPrompt: boolean; revision: number; error?: string | null }
export interface ReadingEstimate { characters: number; paragraphs: number; cost: number | null; model: string | null }
export interface VocabularyHistory { at: number; before: number; after: number; recognized: number; queried: number; reason: 'signals' | 'manual' }
export interface VocabularySignal { kind: 'recognized' | 'queried'; word: string; rank: number }
export interface VocabularyProfile { threshold: number; initialized: boolean; history: VocabularyHistory[]; pendingSignals: number; knownWords: string[] }
export const VocabularyInputSchema = z.object({
  word: WordSchema,
  language: z.string().min(2).max(20).default('en'),
  gloss: z.string().trim().min(1).max(500),
  sentence: z.string().trim().min(1).max(4000),
  target: ReadingTargetSchema,
  concept: z.boolean().default(false)
})
export type VocabularyInput = z.infer<typeof VocabularyInputSchema>
export interface VocabularyLanding { noteId: string; proposalId: string | null; word: string; rowId: string | null; created: boolean }
export interface ReadingWord { word: string; gloss: string; sentence: string; language: string; target: ReadingTarget }

