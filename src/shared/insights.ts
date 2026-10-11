// 洞察看板（v0.9）：一段时间的投入、内化、产出、成本与知识漏斗

export type InsightRange = 7 | 30 | 90
export type FunnelStage = 'discover' | 'read' | 'note' | 'master' | 'apply'

export interface Insights {
  range: InsightRange
  from: number
  to: number
  input: {
    totalMinutes: number
    /** 按活动种类的分钟数（read、listen、write、review、record、practice、chat） */
    byKind: Record<string, number>
    daily: { date: string; minutes: number }[]
    /** 按方向：已完成的学习时段 */
    byDirection: { goalId: string; title: string; color: string | null; minutes: number }[]
  }
  internal: {
    reviews: number
    /** 复习答对率（评分高于“忘了”的占比） */
    retention: number | null
    retentionPrev: number | null
    weekly: { week: string; rate: number | null }[]
    /** 本期新进入长期记忆（稳定度 ≥ 21 天）的卡片 */
    newlyMastered: number
    stableTotal: number
    causes: Record<string, number>
  }
  output: {
    worksCreated: number
    worksDone: number
    decisions: number
    decisionsReviewed: number
    accuracy: number | null
    /** 被作品或决策引用的笔记数 / 占全部笔记 */
    applied: number
    appliedRate: number | null
  }
  cost: { usd: number; byPurpose: { purpose: string; usd: number }[] }
  funnel: { stage: FunnelStage; count: number }[]
  /** 流失最多的一步 */
  leak: { from: FunnelStage; to: FunnelStage; rate: number } | null
}
