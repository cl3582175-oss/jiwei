import type { MistakeCause } from './mistakes'
export interface MistakeStatistics {
  total: number
  verifiedRatio: number
  causes: { cause: MistakeCause; count: number; percentage: number }[]
  concepts: { name: string; count: number }[]
}
