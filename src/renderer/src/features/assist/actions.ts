import i18n from 'i18next'
import { toast } from 'sonner'
import type { Anchor } from '@shared/context'
import type { Effort } from '@shared/ai'
import { PROVIDER_PRESETS } from '@shared/ai'
import type { ChatMessage, ProviderInfo, Settings } from '@shared/types'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { queryClient } from '@/lib/queryClient'
import { errText, sendChat } from '../chat/useChat'
import { useAssist, type AskAction, type Rect } from './store'

// 就地提问：选区快捷操作 → 预加载技能 + 上下文包 → 新的就地对话（挂在原文上）。

export const ACTION_SKILL: Record<AskAction, string | undefined> = {
  explain: 'explain-concept',
  clarify: 'clarify-passage',
  translate: 'translate-passage',
  ask: undefined,
  shorten: 'revise-text',
  expand: 'revise-text',
  simplify: 'revise-text',
  fix: 'revise-text',
  list: 'revise-text',
  revise: 'revise-text',
  remap: 'mindmap'
}

/** 快捷操作默认的提问文字 */
export function actionQuestion(action: AskAction, quote: string, region = false): string {
  if (region && action !== 'ask') return i18n.t(`assist.qRegion.${action}`)
  const q = quote.length > 24 ? quote.slice(0, 24) + '…' : quote
  return i18n.t(`assist.q.${action}`, { q })
}

/**
 * 思考强度：解释、翻译求快（关闭思考）；讲明白与自由提问用设置中的强度。
 * 服务商不支持“关闭”时退回到最低档。
 */
function effortFor(action: AskAction, s: Settings, p: ProviderInfo): Effort {
  const levels = PROVIDER_PRESETS[p.kind].efforts
  const want: Effort = action === 'explain' || action === 'translate' ? 'off' : s.ai.effort
  return levels.includes(want) ? want : levels[0]
}

export async function askInline(
  action: AskAction,
  anchor: Anchor,
  rect: Rect,
  question?: string,
  image?: string,
  extra: Anchor[] = [],
  validate?: () => Promise<unknown>
): Promise<void> {
  const settings = await api.settings.get()
  const providers = await api.providers.list()
  const p = providers.find((x) => x.id === settings.ai.chat.providerId)
  const text = question?.trim() || actionQuestion(action, anchor.quote ?? '', anchor.kind === 'region')
  if (validate) await validate()
  const st = useAssist.getState()
  if (!p || !settings.ai.chat.model) {
    // 保留画面和锚点供配置模型后重试，不能让无会话的卡片永远停在加载骨架。
    st.openCard({
      anchor,
      rect,
      action,
      conversationId: null,
      question: '',
      ...(image ? { image } : {}),
      ...(extra.length ? { extra } : {})
    })
    toast.error(i18n.t('chat.needModel'), {
      action: { label: i18n.t('chat.setupModel'), onClick: () => useApp.getState().openSettings('ai') }
    })
    return
  }
  st.openCard({
    anchor,
    rect,
    action,
    conversationId: null,
    question: text,
    ...(image ? { image } : {}),
    ...(extra.length ? { extra } : {})
  })
  const key = useAssist.getState().card!.key
  const ws = useApp.getState().context
  try {
    const { conversation, userMessage, assistant } = await sendChat({
      conversationId: null,
      text,
      providerId: p.id,
      model: settings.ai.chat.model,
      effort: effortFor(action, settings, p),
      scope: { type: 'all' },
      skill: ACTION_SKILL[action],
      kind: 'inline',
      anchor,
      ...(image ? { images: [image] } : {}),
      context: { targets: [anchor, ...extra].slice(0, 8), noteId: ws.noteId, sourceId: ws.sourceId, cursorRowId: ws.cursorRowId }
    })
    queryClient.setQueryData<ChatMessage[]>(['messages', conversation.id], [userMessage, assistant])
    if (useAssist.getState().card?.key === key) useAssist.getState().updateCard({ conversationId: conversation.id })
    void queryClient.invalidateQueries({ queryKey: ['threads', anchor.parentId] })
  } catch (e) {
    toast.error(errText(e))
  }
}

/** 去掉引用编号，便于存入笔记或复制 */
export const stripCites = (s: string): string => s.replace(/\[(\d{1,2})\]/g, '').replace(/[ \t]+\n/g, '\n')

/** 「存入笔记」：存到工作区当前笔记；没有打开笔记时新建一篇并在资料旁打开 */
export async function saveToNote(input: {
  cue: string
  answer: string
  anchor: Anchor
  model: string | null
  browserEntries?: { id: string; text: string }[]
}): Promise<boolean> {
  const app = useApp.getState()
  try {
    const r = input.browserEntries
      ? await api.browser.captureSave(input.browserEntries, app.noteId)
      : await api.chat.saveAnswer({
          noteId: app.noteId,
          sourceId: input.anchor.parentType === 'source' ? input.anchor.parentId : null,
          cue: input.cue,
          answer: stripCites(input.answer),
          anchor: input.anchor,
          ...(input.model ? { model: input.model } : {})
        })
    if (r.created || app.noteId !== r.noteId) app.navigate({ view: 'notes', noteId: r.noteId })
    if (input.browserEntries && 'proposalId' in r && typeof r.proposalId === 'string') {
      let persisted = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await api.browser.captureSaved(r.proposalId)) {
          persisted = true
          break
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
      }
      if (!persisted) throw new Error(i18n.t('browserCapture.savePending'))
    }
    void queryClient.invalidateQueries({ queryKey: ['notes'] })
    toast.success(i18n.t(r.created ? 'assist.savedNew' : 'assist.saved'))
    return true
  } catch (e) {
    toast.error(errText(e))
    return false
  }
}

/** 就地对话中的追问 */
export async function followUp(conversationId: string, text: string, anchor: Anchor, extra: Anchor[] = []): Promise<void> {
  const settings = await api.settings.get()
  const providers = await api.providers.list()
  const p = providers.find((x) => x.id === settings.ai.chat.providerId)
  if (!p || !settings.ai.chat.model) return void toast.error(i18n.t('chat.needModel'))
  const ws = useApp.getState().context
  try {
    const { userMessage, assistant } = await sendChat({
      conversationId,
      text,
      providerId: p.id,
      model: settings.ai.chat.model,
      effort: effortFor('ask', settings, p),
      scope: { type: 'all' },
      context: { targets: [anchor, ...extra].slice(0, 8), noteId: ws.noteId, sourceId: ws.sourceId }
    })
    queryClient.setQueryData<ChatMessage[]>(['messages', conversationId], (list) => [...(list ?? []), userMessage, assistant])
  } catch (e) {
    toast.error(errText(e))
  }
}

/** 由当前文字选区生成锚点（资料文本：片段 ID + 原文 + 前后文 + 位置） */
export function textSelectionAnchor(sourceId: string): { anchor: Anchor; rect: Rect } | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  const quote = sel.toString().replace(/\s+/g, ' ').trim()
  if (!quote) return null
  const node = range.startContainer
  const el = node instanceof Element ? node : node.parentElement
  const seg = el?.closest<HTMLElement>('[data-segment]') ?? null
  let start: number | undefined
  let prefix: string | undefined
  let suffix: string | undefined
  if (seg) {
    const pre = document.createRange()
    pre.setStart(seg, 0)
    pre.setEnd(range.startContainer, range.startOffset)
    start = pre.toString().length
    const full = seg.textContent ?? ''
    prefix = full.slice(Math.max(0, start - 60), start)
    suffix = full.slice(start + quote.length, start + quote.length + 60)
  }
  const page = seg?.dataset.page ? Number(seg.dataset.page) : undefined
  const t0 = seg?.dataset.t0 ? Number(seg.dataset.t0) : undefined
  const t1 = seg?.dataset.t1 ? Number(seg.dataset.t1) : undefined
  const b = range.getBoundingClientRect()
  return {
    anchor: {
      kind: t0 !== undefined ? 'media-range' : 'source-text',
      parentType: 'source',
      parentId: sourceId,
      ownerId: seg?.dataset.segment ?? null,
      quote: quote.slice(0, 8000),
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
      ...(start !== undefined ? { start, end: start + quote.length } : {}),
      ...(page ? { page } : {}),
      ...(t0 !== undefined ? { t: [t0, t1 ?? t0] as [number, number] } : {})
    },
    rect: { x: b.left, y: b.top, w: b.width, h: b.height }
  }
}
