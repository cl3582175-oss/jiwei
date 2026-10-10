import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { mistakes, notes } from '../db/schema'
import type { Mistake } from '@shared/mistakes'
import { mistakeText } from './mistakesMessages'

type SourceIdentity = Pick<Mistake, 'id' | 'sourceKind' | 'sourceRef' | 'assetId'>
let sourceGuard: (source: SourceIdentity) => void = () => undefined
/** 入口所属服务解析服务器保留的来源身份，不能相信 renderer 传入的允许标记。 */
export function setMistakePrivacyGuard(guard: (source: SourceIdentity) => void): void { sourceGuard = guard }
export function requireMistake(id: string): typeof mistakes.$inferSelect {
  const row = getDb().select().from(mistakes).where(eq(mistakes.id, id)).get()
  if (!row || row.deletedAt) throw new Error(mistakeText('missing'))
  return row
}
export function requireMistakeCloud(id: string): void {
  const row = requireMistake(id)
  if ((JSON.parse(row.flags) as string[]).includes('local-only')) throw new Error(mistakeText('localOnly'))
  if (row.noteId) {
    const note = getDb().select().from(notes).where(eq(notes.id, row.noteId)).get()
    if (!note || note.deletedAt || note.aiExcluded) throw new Error(mistakeText('localOnly'))
  }
  sourceGuard(row)
}
