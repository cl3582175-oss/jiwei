import { createHash } from 'node:crypto'
import { getDb } from '../../db'
import { notes, sources, mistakes } from '../../db/schema'
import { getSettings } from '../settings'
import { requireMistakeCloud } from '../mistakesPrivacy'

/** 记录撤回的来源身份，标题变化不会丢失依据；新增允许素材不会使旧结果失效。 */
export function privacyFingerprint(): string {
  const db = getDb()
  const excluded = [notes, sources].map((table) =>
    db
      .select({ id: table.id, deletedAt: table.deletedAt, aiExcluded: table.aiExcluded })
      .from(table)
      .all()
      .filter((r) => r.deletedAt !== null || r.aiExcluded)
      .map((r) => r.id)
      .sort()
  )
  const excludedMistakes = db
    .select({ id: mistakes.id })
    .from(mistakes)
    .all()
    .flatMap((m) => {
      try {
        requireMistakeCloud(m.id)
        return []
      } catch {
        return [m.id]
      }
    })
    .sort()
  return createHash('sha256')
    .update(
      JSON.stringify({
        excluded,
        excludedMistakes,
        blocked: [...(getSettings().browser?.aiBlockedSites ?? [])].map((s) => s.toLowerCase()).sort()
      })
    )
    .digest('hex')
}
