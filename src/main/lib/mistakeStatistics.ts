import { MistakeCauseSchema } from '@shared/mistakes'
import type { MistakeCause } from '@shared/mistakes'
import type { MistakeStatistics } from '@shared/learningStats'

export function summarizeMistakes(rows: { cause: MistakeCause; verified: boolean; concepts: string[] }[]): MistakeStatistics {
  const concepts = new Map<string, number>()
  for (const row of rows) for (const name of new Set(row.concepts)) concepts.set(name, (concepts.get(name) ?? 0) + 1)
  return {
    total: rows.length,
    verifiedRatio: rows.length ? rows.filter((r) => r.verified).length / rows.length : 0,
    causes: MistakeCauseSchema.options.map((cause) => {
      const count = rows.filter((r) => r.cause === cause).length
      return { cause, count, percentage: rows.length ? count * 100 / rows.length : 0 }
    }),
    concepts: [...concepts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3)
  }
}
