import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { PodcastState, PodcastScript } from '@shared/discover'
import { addDays, dayStart, localDay } from '@shared/plan'
import { nextOffPeak } from '@shared/inbox'
import { getDb } from '../../db'
import { blocks, cards, feedItems, mistakes, notes, sources } from '../../db/schema'
import { podcastMaterial, podcastPrompt, podcastSchema } from '../../lib/podcast'
import { tr } from '../../lib/messages'
import { getSettings } from '../settings'
import { getMeta, setMeta } from '../memory'
import { withRun } from '../agent/context'
import { isBudgetError, perRunLimit } from '../agent/usage'
import { audit } from '../agent/audit'
import { requireMistakeCloud } from '../mistakesPrivacy'
import { enqueue, registerJobKind, runJobNow } from '../jobs'
import { allowedCandidate, allowedRelated } from './context'
import { knowledgeTarget } from './items'
import { checkDiscoveryBudget, dailyStatus, discoveryModel } from './daily'
import { discoverChanged } from './feeds'

const KEY = 'discover.podcast'
type Stored = PodcastState & { signature?: string }
function stored(now = Date.now()): Stored {
  const value = getMeta(KEY)
  if (value) {
    const row = JSON.parse(value) as Stored
    if (row.date === localDay(now)) return row
  }
  return { date: localDay(now), status: 'idle', message: null, script: null }
}
function update(patch: Partial<Stored>): void {
  setMeta(KEY, JSON.stringify({ ...stored(), ...patch }))
  discoverChanged()
}

function material(now = Date.now()) {
  const db = getDb(),
    allNotes = db.select().from(notes).all(),
    allSources = db.select().from(sources).all()
  const privateTitles = [...allNotes, ...allSources]
    .filter((r) => r.deletedAt || r.aiExcluded)
    .map((r) => r.title)
    .filter(Boolean)
  const picks = db
    .select()
    .from(feedItems)
    .where(and(isNull(feedItems.deletedAt), eq(feedItems.status, 'picked')))
    .all()
    .map((p) => {
      const refs = JSON.parse(p.related) as { type: 'note' | 'source'; id: string }[]
      let allowed =
        allowedRelated(refs).length === refs.length && !privateTitles.some((title) => `${p.title}\n${p.reason ?? ''}`.includes(title))
      try {
        allowed &&= !!knowledgeTarget(p.url) || allowedCandidate(p.url)
      } catch {
        allowed = false
      }
      return { id: p.id, title: p.title, reason: p.reason ?? '', pickedAt: p.pickedAt ?? 0, allowed }
    })
  const due = db
    .select({ card: cards })
    .from(cards)
    .innerJoin(notes, eq(notes.id, cards.noteId))
    .where(
      and(
        isNull(cards.deletedAt),
        eq(cards.suspended, false),
        isNull(notes.deletedAt),
        eq(notes.aiExcluded, false),
        eq(notes.reviewExcluded, false),
        lt(cards.due, addDays(dayStart(now), 1))
      )
    )
    .orderBy(asc(cards.due))
    .all()
    .map(({ card }) => {
      let allowed = true,
        question = ''
      if (card.mistakeId) {
        try {
          requireMistakeCloud(card.mistakeId)
          question = db.select().from(mistakes).where(eq(mistakes.id, card.mistakeId)).get()?.question ?? ''
        } catch {
          allowed = false
        }
      } else {
        question = db
          .select({ text: blocks.text })
          .from(blocks)
          .where(and(eq(blocks.noteId, card.noteId), eq(blocks.rowId, card.blockId), eq(blocks.section, 'cue'), isNull(blocks.deletedAt)))
          .orderBy(asc(blocks.position))
          .all()
          .map((b) => b.text)
          .join('\n')
      }
      return { id: card.id, due: card.due, question, allowed }
    })
  const reminders = db
    .select()
    .from(mistakes)
    .where(isNull(mistakes.deletedAt))
    .orderBy(desc(mistakes.updatedAt))
    .all()
    .map((m) => {
      let allowed = true
      try {
        requireMistakeCloud(m.id)
      } catch {
        allowed = false
      }
      return { id: m.id, question: m.question, concepts: JSON.parse(m.concepts) as string[], cause: m.cause, allowed }
    })
  const facts = podcastMaterial({ picks, cards: due, mistakes: reminders }, now)
  return {
    facts,
    signature: createHash('sha256')
      .update(JSON.stringify({ facts, language: getSettings().language }))
      .digest('hex')
  }
}

export function podcast(): PodcastState {
  const row = stored()
  if (!getSettings().discover.podcast) return { date: row.date, status: 'idle', message: null, script: null }
  if (row.script && row.signature !== material().signature)
    return {
      date: row.date,
      status: row.status === 'ok' ? 'stale' : row.status,
      script: null,
      message: row.status === 'ok' ? tr('素材或隐私设置已变化，请重新生成讲稿', 'Materials or privacy settings changed; regenerate the script') : row.message
    }
  return { date: row.date, status: row.status, message: row.message, script: row.script }
}
export function generatePodcast(immediate = true): string {
  const s = getSettings()
  if (!s.discover.podcast) throw new Error(tr('请先开启每日学习播客', 'Enable the daily learning podcast first'))
  if (stored().status === 'running') throw new Error(tr('讲稿正在生成', 'Script generation is already running'))
  if (!s.ai.chat.model) throw new Error(tr('请先配置 AI 模型', 'Configure an AI model first'))
  const id = enqueue('discover.podcast', {}, { dedupeKey: 'discover.podcast', ...(immediate ? {} : { runAfter: nextOffPeak(Date.now()) }) })
  update({ status: 'queued', message: null })
  if (immediate) runJobNow(id)
  return id
}
export function checkPodcast(now = Date.now()): void {
  const s = getSettings()
  if (!s.discover.podcast || !s.ai.chat.model || stored(now).status !== 'idle' || ['queued', 'running'].includes(dailyStatus().status))
    return
  const f = material(now).facts
  if (!f.picks.length && !f.questions.length && !f.reminder) return
  generatePodcast(false)
}
export function registerPodcastJob(): void {
  if (stored().status === 'running')
    update({
      status: 'error',
      message: tr('上次讲稿生成被中断，可重新生成', 'The previous script generation was interrupted; regenerate it')
    })
  registerJobKind('discover.podcast', {
    title: () => tr('每日学习播客讲稿', 'Daily learning podcast script'),
    offPeak: true,
    maxAttempts: 1,
    retryOnRestart: false,
    run: async (_payload, ctx) => {
      const input = material(),
        date = localDay(Date.now()),
        language = getSettings().language
      const guard = (): void => {
        ctx.signal?.throwIfAborted()
        if (ctx.isCanceled() || !getSettings().discover.podcast || localDay(Date.now()) !== date) throw new Error('Canceled')
        checkDiscoveryBudget()
        if (material().signature !== input.signature) throw new Error('Podcast materials changed')
      }
      update({ status: 'running', message: null })
      try {
        const script = await withRun({ purpose: 'discover.podcast', caller: 'job', perRun: perRunLimit() }, async () => {
          guard()
          if (!input.facts.picks.length && !input.facts.questions.length && !input.facts.reminder) throw new Error('No podcast materials')
          const draft = await discoveryModel(
            'discover.podcast',
            podcastSchema(language),
            podcastPrompt(language),
            input.facts,
            guard,
            ctx.signal
          )
          guard()
          return { date, paragraphs: draft.paragraphs, createdAt: Date.now() } satisfies PodcastScript
        })
        update({ status: 'ok', script, signature: input.signature, message: null })
        audit({ caller: 'job', tool: 'discover.podcast', level: 'write', status: 'ok', summary: 'Daily learning script saved' })
      } catch (e) {
        const status = isBudgetError(e)
          ? 'budget'
          : ctx.signal?.aborted || ctx.isCanceled() || !getSettings().discover.podcast
            ? 'canceled'
            : 'error'
        const message =
          status === 'budget'
            ? tr('今日发现费用已达上限，讲稿生成已停止', 'Discovery budget reached; script generation stopped')
            : status === 'canceled'
              ? tr('讲稿生成已取消', 'Script generation canceled')
              : tr('讲稿未生成，请检查模型、素材或重新生成', 'Script not generated; check model and materials or try again')
        update({ status, message })
        audit({ caller: 'job', tool: 'discover.podcast', level: 'write', status: 'error', summary: message })
        // 队列会保存异常，说明书§0.2禁止把原模型响应或可能的凭证复制进日志。
        // eslint-disable-next-line preserve-caught-error -- 此处是错误脱敏边界，分类已写入领域状态和审计。
        throw new Error(message)
      }
    },
    onCancel: () => update({ status: 'canceled', message: tr('讲稿生成已取消', 'Script generation canceled') })
  })
}
