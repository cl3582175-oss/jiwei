import { and, gte, lt, isNull } from 'drizzle-orm'
import { getDb } from '../db'
import { mistakes } from '../db/schema'
import { summarizeMistakes } from '../lib/mistakeStatistics'
import type { MistakeStatistics } from '@shared/learningStats'
import { z } from 'zod'

export function mistakeStatistics(start?: number, end?: number, noteIds?: string[]): MistakeStatistics {
  const rows = getDb().select().from(mistakes).where(and(
    isNull(mistakes.deletedAt),
    start === undefined ? undefined : gte(mistakes.createdAt, start),
    end === undefined ? undefined : lt(mistakes.createdAt, end)
  )).all().filter((r) => !noteIds || (r.noteId && noteIds.includes(r.noteId)))
  return summarizeMistakes(rows.map((r) => ({
    cause: r.cause,
    verified: r.verified,
    concepts: (() => { try { return z.array(z.string()).parse(JSON.parse(r.concepts)) } catch { return [] } })()
  })))
}
