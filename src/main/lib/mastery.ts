import type { MasteryStatus } from '@shared/types'

// 掌握度的判断规则（纯函数，便于测试）。
// recall：FSRS 可提取性——现在还记得的概率；stability：记忆稳定性（天），可提取性降到 90% 所需的时间。

/** 牢固：现在记得的概率高，且记忆能保持三周以上 */
export const SOLID_RECALL = 0.85
export const SOLID_STABILITY = 21
/** 薄弱：现在多半已经忘了 */
export const WEAK_RECALL = 0.7

export function cardSolid(recall: number, stability: number): boolean {
  return recall >= SOLID_RECALL && stability >= SOLID_STABILITY
}

export function noteStatus(n: { cards: number; reviewed: number; recall: number | null; stability: number | null }): MasteryStatus {
  if (!n.cards) return 'blank'
  if (!n.reviewed || n.recall === null) return 'new'
  if (n.recall < WEAK_RECALL) return 'weak'
  return cardSolid(n.recall, n.stability ?? 0) ? 'solid' : 'learning'
}
