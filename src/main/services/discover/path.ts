import { z } from 'zod'
import { PathDraft, type LearningPath, type DiscoveryScore } from '@shared/discover'
import { addDays, dayStart, localDay, type SchedulePreview } from '@shared/plan'
import { withRun } from '../agent/context'
import { perRunLimit } from '../agent/usage'
import { listGoals } from '../progress'
import { retrieve } from '../ai/retrieve'
import { createNote } from '../notes'
import { createProposal } from '../proposals'
import { markdownToNodes } from '../../lib/markdown'
import { newId } from '../../lib/ids'
import { getSettings } from '../settings'
import { getDb } from '../../db'
import { feedItems } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { emit } from '../../events'
import { requireMistake, requireMistakeCloud } from '../mistakesPrivacy'
import { audit } from '../agent/audit'
import { previewPathPhases } from '../plan/schedule'
import { tr } from '../../lib/messages'
import { hasWebBackend, searchWeb } from '../retrieval/gateway'
import { checkDiscoveryBudget, discoveryModel } from './daily'
import { discoveryContext, allowedCandidate } from './context'
import { upsertCandidate } from './feeds'
import { publishPick } from './items'
import { privacyFingerprint } from '../ai/privacy'

type Resource = LearningPath['steps'][number]['resources'][number] & { text: string }
async function resources(query: string, guard: () => void): Promise<Resource[]> {
  guard()
  const hits = await retrieve(query, { type: 'all' }, 15)
  guard()
  const map = new Map<string, Resource>()
  for (const h of hits) {
    const id = `${h.parentType}:${h.parentId}`
    if (!map.has(id)) map.set(id, { id, title: h.title, type: h.parentType, text: h.text.slice(0, 800) })
  }
  if (getSettings().discover.useSearch && hasWebBackend())
    for (const { url, title, snippet } of (await searchWeb(query, { count: 8, guard })).results)
      map.set(url, { id: url, title, type: 'web', url, text: snippet })
  guard()
  return [...map.values()].slice(0, 12)
}
const paths = new Map<string, { path: LearningPath; signature: string }>()
export async function path(goalId: string): Promise<LearningPath> {
  const goal = listGoals().find((g) => g.id === goalId && g.status === 'active')
  if (!goal) throw new Error('Active direction not found')
  const context = discoveryContext(goalId),
    guard = (): void => {
      checkDiscoveryBudget()
      if (discoveryContext(goalId).signature !== context.signature) throw new Error('Path context changed')
    }
  return withRun({ purpose: 'discover.path', caller: 'app', perRun: perRunLimit() }, async () => {
    const pool = await resources(`${goal.title} ${goal.description ?? ''}`, guard)
    if (!pool.length)
      throw new Error(tr('没有可用资源，请补充知识库内容或配置搜索服务', 'No resources found; add knowledge or configure search'))
    const draft = await discoveryModel(
      'discover.path',
      PathDraft,
      'Create a progressive 4–8 step learning path, from foundations to advanced practice. Each step has a question (Cornell cue), objective, and 1–3 resourceIds exclusively from the supplied pool. Distinguish knowledge-base resources from web resources. Do not invent resources or claims about them.',
      { context: context.facts, resources: pool },
      guard
    )
    guard()
    const steps = draft.steps.map((s) => {
      const selected = [...new Set(s.resourceIds)].map((id) => pool.find((r) => r.id === id)).filter((r): r is Resource => !!r)
      if (!selected.length || selected.some((r) => r.url && !allowedCandidate(r.url))) throw new Error('Invalid learning path resources')
      return {
        title: s.title,
        question: s.question,
        objective: s.objective,
        resources: selected.map((r) => ({ id: r.id, title: r.title, type: r.type, ...(r.url ? { url: r.url } : {}) }))
      }
    })
    const title = `${goal.title} · ${tr('学习路径', 'Learning path')}`
    let noteId = '',
      proposalId = ''
    getDb().transaction(() => {
      const note = createNote({ title, categoryId: goal.categoryId }),
        proposal = createProposal({
          noteId: note.id,
          title,
          model: getSettings().ai.chat.model ?? undefined,
          ops: steps.map((s) => ({
            op: 'insert_row' as const,
            afterRowId: null,
            cue: markdownToNodes(`${s.title}：${s.question}`),
            body: markdownToNodes(
              `${s.objective}\n\n${s.resources.map((r) => `- [${r.title}](${r.type === 'web' ? r.url : `jiwei://${r.type}/${r.id.split(':').slice(1).join(':')}`})（${r.type === 'web' ? tr('网上', 'Web') : tr('知识库', 'Knowledge base')}）`).join('\n')}`
            )
          }))
        })
      noteId = note.id
      proposalId = proposal.id
    })
    audit({ caller: 'app', tool: 'discover.path', level: 'write', status: 'ok', summary: 'Learning path proposed in a new note' })
    emit('notes:changed', { ids: [noteId] })
    const result: LearningPath = { id: newId(), noteId, proposalId, goalId, steps, expiresAt: Date.now() + 30 * 60000 }
    for (const [id, entry] of paths) if (entry.path.expiresAt < Date.now()) paths.delete(id)
    if (paths.size >= 20) paths.delete(paths.keys().next().value!)
    // 新建空笔记使允许集合变化，记录创建完成后的上下文，再验证阶段确认。
    paths.set(result.id, { path: result, signature: discoveryContext(goalId).signature })
    emit('discover:changed', {})
    return result
  })
}
export function pathPhases(id: string): SchedulePreview {
  const entry = paths.get(id),
    now = Date.now()
  if (!entry || entry.path.expiresAt < now) throw new Error('Path preview expired')
  const p = entry.path,
    goal = listGoals().find((g) => g.id === p.goalId && g.status === 'active')
  if (!goal) throw new Error('Active direction not found')
  const guard = (): void => {
    if (discoveryContext(p.goalId).signature !== entry.signature) throw new Error('Path context changed; regenerate')
  }
  guard()
  const start = Math.max(dayStart(now), dayStart(goal.startAt ?? now)),
    end = goal.targetAt ?? addDays(start, 60),
    days = Math.round((dayStart(end) - start) / 86400000) + 1
  if (days < p.steps.length)
    throw new Error(tr('截止日前的天数不足，请先调整方向日期', 'Not enough days before the deadline; adjust the direction dates'))
  const total = goal.weeklyMinutes ?? 180
  return previewPathPhases(
    {
      goalId: goal.id,
      startAt: start,
      targetAt: end,
      weekdayMinutes: goal.weekdayMinutes ?? Array.from({ length: 7 }, (_, i) => Math.floor(total / 7) + (i < total % 7 ? 1 : 0))
    },
    {
      phases: p.steps.map((s, i) => ({
        title: s.title,
        objective: s.objective,
        start: localDay(addDays(start, Math.floor((i * days) / p.steps.length))),
        end: localDay(addDays(start, Math.floor(((i + 1) * days) / p.steps.length) - 1))
      })),
      milestones: [],
      sessions: [],
      tradeoffs: tr(
        '仅追加学习路径阶段；已有阶段、里程碑与日程均保留',
        'Append path phases; preserve existing phases, milestones and events'
      )
    },
    p.steps.map((s) => ({
      noteIds: s.resources.filter((r) => r.type === 'note').map((r) => r.id.slice(5)),
      sourceIds: s.resources.filter((r) => r.type === 'source').map((r) => r.id.slice(7))
    })),
    guard
  )
}
const Remedies = z.object({
  resources: z
    .array(
      z.object({ id: z.string(), reason: z.string().min(1).max(800), gap: z.string().max(500), minutes: z.number().int().min(1).max(240) })
    )
    .max(3)
})
export async function remedy(mistakeId: string): Promise<string[]> {
  requireMistakeCloud(mistakeId)
  const m = requireMistake(mistakeId),
    context = discoveryContext(),
    guard = (): void => {
      requireMistakeCloud(mistakeId)
      checkDiscoveryBudget()
      if (discoveryContext().signature !== context.signature || requireMistake(mistakeId).updatedAt !== m.updatedAt)
        throw new Error('Mistake context changed')
    }
  return withRun({ purpose: 'discover.remedy', caller: 'app', perRun: perRunLimit() }, async () => {
    const concepts = JSON.parse(m.concepts) as string[],
      pool = await resources(`${concepts.join(' ')} ${m.cause} ${m.question.slice(0, 200)}`, guard)
    if (!pool.length)
      throw new Error(
        tr('没有找到讲解与练习，请补充知识库或配置搜索', 'No explanations or practice found; add knowledge or configure search')
      )
    const result = await discoveryModel(
      'discover.remedy',
      Remedies,
      'Select up to three explanations and practice resources for the supplied mistake concepts and cause. Use only supplied resource IDs; explain a specific gap and mention the concept. No daily quota applies to this explicit remedy request.',
      { concepts, cause: m.cause, causeReason: m.causeReason, resources: pool },
      guard
    )
    guard()
    const ids: string[] = [],
      seen = new Set<string>()
    for (const choice of result.resources) {
      const r = pool.find((r) => r.id === choice.id)
      if (!r || seen.has(r.id)) continue
      seen.add(r.id)
      const related = r.type === 'web' ? [] : [{ type: r.type, id: r.id.slice(r.type.length + 1) }],
        url = r.url ?? `jiwei://${r.type}/${r.id.slice(r.type.length + 1)}`,
        id = upsertCandidate(
          { url, title: r.title, summary: r.text.slice(0, 4000), author: null, publishedAt: null, audioUrl: null, pdfUrl: null },
          null,
          'search'
        ),
        score: DiscoveryScore = {
          privacySignature: privacyFingerprint(),
          relevance: 5,
          novelty: 0,
          credibility: 3,
          depth: 3,
          minutes: choice.minutes,
          reason: choice.reason,
          gap: choice.gap,
          related,
          goalIds: [],
          diverse: false,
          news: false
        }
      const current = getDb().select().from(feedItems).where(eq(feedItems.id, id)).get()!
      if (current.status === 'saved') continue
      publishPick(id, score, mistakeId)
      ids.push(id)
    }
    return ids
  })
}
