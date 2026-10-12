import { z } from 'zod'
import type { PluginRegistryItem, PluginFramework } from './plugins'

// 参谋与决策日志（v0.9）：备忘录由模型按此结构生成；依据只能引用所供素材的编号。

const text = (max: number) => z.string().trim().min(1).max(max)

export const DecisionMemoDraft = z.object({
  /** 对问题的一句话重述（帮助用户确认 AI 理解对了） */
  restated: text(300),
  options: z
    .array(z.object({ id: z.string().regex(/^O[1-9]$/), title: text(80), summary: text(400) }))
    .min(2)
    .max(5),
  criteria: z
    .array(z.object({ name: text(200), weight: z.number().int().min(1).max(5), why: z.string().max(200).default('') }))
    .min(2)
    .max(8),
  /** 每个选项在每条准则上的评分 1–5 */
  scores: z
    .array(
      z.object({ option: z.string(), criterion: z.string(), score: z.number().int().min(1).max(5), why: z.string().max(240).default('') })
    )
    .max(40),
  evidence: z
    .array(z.object({ source: z.string().regex(/^S\d{1,2}$/), claim: text(300), supports: z.string().max(10).optional() }))
    .max(12),
  assumptions: z.array(text(240)).max(6),
  /** 事前验尸：假设一年后这个决定失败了，最可能的原因 */
  premortem: z.array(text(240)).max(5),
  secondOrder: z.array(text(240)).max(5),
  counter: z.string().max(600).default(''),
  risks: z.array(z.object({ risk: text(240), mitigation: z.string().max(240).default('') })).max(6),
  recommendation: z.object({ option: z.string(), why: text(600) }),
  confidence: z.number().int().min(1).max(5),
  /** 还缺什么信息才能更有把握 */
  unknowns: z.array(text(200)).max(5)
})
export type DecisionMemoDraft = z.infer<typeof DecisionMemoDraft>

export interface MemoSource {
  id: string
  parentType: 'note' | 'source'
  parentId: string
  ownerId: string
  title: string
  text: string
  locator: string | null
  /** 读取时复核：已删除或改为“不给 AI”时为 false */
  available?: boolean
}
export type DecisionMemo = DecisionMemoDraft & { sources: MemoSource[]; generatedAt: number }

export type DecisionStatus = 'draft' | 'decided' | 'reviewed' | 'dropped'
export interface Decision {
  id: string
  question: string
  context: string
  framework?: PluginRegistryItem<PluginFramework> | null
  status: DecisionStatus
  memo: DecisionMemo | null
  weights: Record<string, number> | null
  choice: string | null
  expectation: string | null
  reviewAt: number | null
  outcome: string | null
  accuracy: number | null
  lesson: string | null
  goalId: string | null
  model: string | null
  createdAt: number
  updatedAt: number
}

export const AdvisorAskSchema = z.object({
  frameworkId: z.string().max(257).optional(),
  question: z.string().trim().min(4).max(500),
  context: z.string().max(3000).default(''),
  goalId: z.string().max(64).nullable().default(null)
})
export type AdvisorAsk = z.input<typeof AdvisorAskSchema>

export const DecideSchema = z.object({
  id: z.string().max(64),
  choice: z.string().trim().min(1).max(200),
  expectation: z.string().trim().min(1).max(1000),
  reviewAt: z.number().int().positive()
})
export const ReviewDecisionSchema = z.object({
  id: z.string().max(64),
  outcome: z.string().trim().min(1).max(2000),
  accuracy: z.number().int().min(1).max(5),
  lesson: z.string().max(600).default(''),
  /** 把教训写成一张复习卡片 */
  card: z.boolean().default(false)
})

/** 按（可能被用户调整过的）权重算每个选项的加权得分，0–100 */
export function matrixTotals(
  memo: Pick<DecisionMemoDraft, 'options' | 'criteria' | 'scores'>,
  weights?: Record<string, number> | null
): Record<string, number> {
  const w = (c: { name: string; weight: number }): number => weights?.[c.name] ?? c.weight
  const sum = memo.criteria.reduce((n, c) => n + w(c), 0) || 1
  const out: Record<string, number> = {}
  for (const o of memo.options) {
    let total = 0
    for (const c of memo.criteria) {
      const s = memo.scores.find((x) => x.option === o.id && x.criterion === c.name)?.score ?? 0
      total += (s / 5) * w(c)
    }
    out[o.id] = Math.round((total / sum) * 100)
  }
  return out
}
