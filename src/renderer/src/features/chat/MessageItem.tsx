import { useQuery } from '@tanstack/react-query'
import { useReplySelection } from '../assist/replySelection'
import { elementRect, useAssist } from '../assist/store'
import { MessageReadiness } from './MessageReadiness'
import { MessageAttachments } from '../attachments/ConversationAttachments'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useMoney } from '@/lib/money'
import { useTranslation } from 'react-i18next'
import { Streamdown } from 'streamdown'
import {
  Brain,
  ChevronRight,
  NotebookText,
  FileText,
  CircleAlert,
  Archive,
  Sparkles,
  Copy,
  Check,
  LoaderCircle,
  CircleX,
  ListChecks,
  ArrowUpRight,
  Library,
  Globe
} from 'lucide-react'
import type { AgentStep, ChatMessage, Citation } from '@shared/types'
import { api, cn, formatDate } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Tip } from '@/components/ui/primitives'
import { ApprovalCard, BudgetNotice, StepLinkButton, budgetKind } from '@/features/agent/ChatCards'
import { useWebSnapshot } from '@/features/retrieval/store'
import { UiFence } from '@/features/ui/UiFence'
import { UiMessageProvider } from '@/features/ui/context'
import { annotateUiFences, uiAnswerText, mapOutsideFences } from '@shared/ui/fences'
import type { UiEvent } from '@shared/ui/events'
import { MermaidFence } from './MermaidFence'
import { locatorFields } from '@shared/context'

const plainPlugins = { renderers: [{ language: 'mermaid', component: MermaidFence }] }
const uiPlugins = { renderers: [...plainPlugins.renderers, { language: 'jiwei-ui', component: UiFence }] }

/** 打开引用：知识库定位到段落 / 页码，网页打开快照或原网页。 */
export function openCitation(c: Citation, conversationId?: string): void {
  const s = useApp.getState()
  if (c.parentType === 'web') {
    if (c.snippetOnly || !c.parentId || c.parentId.startsWith('tmp-')) {
      if (c.url) s.openBrowser(c.url)
    } else useWebSnapshot.getState().open(c.parentId, c.locator, c.url)
    return
  }
  s.setHighlight({
    type: c.parentType === 'note' ? 'block' : 'segment',
    id: c.ownerId,
    ...(c.parentType === 'source'
      ? { sourceId: c.parentId, selector: c.selector ?? { ...locatorFields(c.locator), quote: c.snippet } }
      : {}),
    locator: c.locator,
    conversationId
  })
  if (c.parentType === 'note') s.openNote(c.parentId)
  else s.openSource(c.parentId, conversationId)
}

function citationSite(c: Citation): string {
  if (c.site) return c.site
  try {
    return c.url ? new URL(c.url).hostname : ''
  } catch {
    return ''
  }
}

function CiteChip({ n, citation, conversationId }: { n: number; citation?: Citation; conversationId: string }) {
  if (!citation) return <sup className="text-subtle">[{n}]</sup>
  const web = citation.parentType === 'web'
  const site = web ? citationSite(citation) : ''
  return (
    <Tip
      label={web ? [site, citation.title].filter(Boolean).join(' · ') : `${citation.title} · ${citation.snippet.slice(0, 60)}…`}
      side="top"
    >
      <button
        onClick={() => openCitation(citation, conversationId)}
        className={cn('cite-chip', web && 'cite-chip-web')}
        aria-label={`[${n}] ${citation.title}`}
        data-testid={web ? 'web-cite-chip' : undefined}
      >
        {n}
      </button>
    </Tip>
  )
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function Reasoning({ text, streaming, seconds }: { text: string; streaming: boolean; seconds: number | null }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-subtle transition-colors hover:bg-surface-hover hover:text-fg"
      >
        <Brain className={cn('size-3.5', streaming && 'animate-pulse text-accent')} />
        {streaming ? t('chat.thinking') : seconds ? t('chat.thoughtFor', { s: seconds }) : t('chat.thought')}
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="mt-2 border-l-2 border-border pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted">{text}</div>}
    </div>
  )
}

/** 提案类步骤：需要用户到笔记里确认，始终显示 */
const isProposal = (s: AgentStep): boolean =>
  s.tool.startsWith('note_') && !['note_read', 'note_find', 'note_create'].includes(s.tool) && !s.approval

function StepRow({ s }: { s: AgentStep }) {
  const { t } = useTranslation()
  const open = (): void => {
    if (!s.link) return
    if (s.link.type === 'note') useApp.getState().openNote(s.link.id)
    else useApp.getState().openSource(s.link.id)
  }
  return (
    <li className="flex items-start gap-2 text-xs">
      {s.status === 'running' || s.status === 'waiting' ? (
        <LoaderCircle className="mt-px size-3.5 shrink-0 animate-spin text-accent" />
      ) : s.status === 'denied' ? (
        <CircleX className="mt-px size-3.5 shrink-0 text-subtle" />
      ) : s.status === 'error' ? (
        <CircleX className="mt-px size-3.5 shrink-0 text-danger" />
      ) : (
        <Check className="mt-px size-3.5 shrink-0 text-accent" />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn('text-muted', s.status === 'error' && 'text-danger')}>{s.label}</span>
        {s.detail && <span className="block text-2xs break-all text-subtle">{s.detail}</span>}
      </span>
      {s.link && !isProposal(s) && s.status === 'done' && s.link.type !== 'note' && s.link.type !== 'source' && (
        <StepLinkButton link={s.link} />
      )}
      {s.link && isProposal(s) && s.status === 'done' && (
        <button onClick={open} className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-accent hover:underline">
          {t('chat.reviewProposal')}
          <ArrowUpRight className="size-3" />
        </button>
      )}
    </li>
  )
}

function Steps({ steps, streaming }: { steps: AgentStep[]; streaming: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const proposals = steps.filter(isProposal)
  const approvals = steps.filter((s) => s.approval)
  const others = steps.filter((s) => !isProposal(s) && !s.approval)
  const expanded = open || streaming
  return (
    <div className="mb-3 space-y-1.5">
      {others.length > 0 && (
        <div>
          <button
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-subtle transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <ListChecks className="size-3.5" />
            {t('chat.steps', { count: others.length })}
            <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
          </button>
          {expanded && (
            <ul className="mt-1.5 space-y-1 border-l-2 border-border pl-3">
              {others.map((s) => (
                <StepRow key={s.id} s={s} />
              ))}
            </ul>
          )}
        </div>
      )}
      {approvals.length > 0 && (
        <div className="space-y-1.5">
          {approvals.map((s) => (
            <ApprovalCard key={s.id} step={s} />
          ))}
        </div>
      )}
      {proposals.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-accent/25 bg-accent-soft/40 px-3 py-2">
          {proposals.map((s) => (
            <StepRow key={s.id} s={s} />
          ))}
        </ul>
      )}
    </div>
  )
}

function CitationCard({ c, conversationId }: { c: Citation; conversationId: string }) {
  const { t, i18n } = useTranslation()
  const web = c.parentType === 'web'
  const date = c.parentType === 'note' ? c.updatedAt : (c.learnedAt ?? c.updatedAt)
  const dateLabel =
    date === null || (!web && !date)
      ? ''
      : web && c.learnedAt === null
        ? t('retrieval.snapshot.fetchedAt', { date: formatDate(date, i18n.language) })
        : formatDate(date, i18n.language)
  return (
    <button
      onClick={() => openCitation(c, conversationId)}
      className="group flex w-full gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover"
      data-testid={web ? 'web-citation-card' : undefined}
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-accent-soft font-mono text-2xs text-accent">{c.n}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('flex items-center gap-1.5 text-xs text-fg', web && 'flex-wrap')}>
          {c.parentType === 'note' ? (
            <NotebookText className="size-3.5 shrink-0 text-subtle" />
          ) : web ? (
            <Globe className="size-3.5 shrink-0 text-subtle" />
          ) : (
            <FileText className="size-3.5 shrink-0 text-subtle" />
          )}
          <span className="min-w-0 truncate font-medium">{c.title || t('common.untitled')}</span>
          {web && <span className="min-w-0 truncate text-2xs text-subtle">{citationSite(c)}</span>}
          {!web && c.locator && (
            <span className="shrink-0 text-2xs text-subtle">{c.locator.replace('page=', 'p.').replace('chapter=', '§')}</span>
          )}
          {web && c.snippetOnly && (
            <span className="shrink-0 rounded bg-sunken px-1 text-2xs text-subtle" data-testid="web-citation-snippet">
              {t('retrieval.citation.snippet')}
            </span>
          )}
          {web && c.meta?.doi && (
            <span className="shrink-0 rounded bg-sunken px-1 text-2xs text-subtle" data-testid="web-citation-academic">
              {t('retrieval.citation.academic')}
            </span>
          )}
          {web && c.suspicious && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-[#b8862b]" data-testid="web-citation-suspicious">
              <CircleAlert className="size-3" />
              {t('retrieval.citation.suspicious')}
            </span>
          )}
          {c.status === 'outdated' && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle">
              <Archive className="size-3" />
              {t('notes.status.outdated')}
            </span>
          )}
          {c.status === 'disputed' && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-[#b8862b]">
              <CircleAlert className="size-3" />
              {t('notes.status.disputed')}
            </span>
          )}
          {c.origin === 'ai' && <Sparkles className="size-3 shrink-0 text-subtle" />}
          {(c.projectSource || c.via) && (
            <span className="shrink-0 rounded bg-sunken px-1 text-2xs text-subtle">
              {t(c.projectSource ? 'projects.sourceBasis' : `chat.via.${c.via}`)}
            </span>
          )}
          <span className="ml-auto shrink-0 text-2xs text-subtle">{dateLabel}</span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-2xs leading-relaxed text-muted">{c.snippet.replace(/^#{1,6}\s+/gm, '')}</span>
      </span>
    </button>
  )
}

/** 回复选择题（v0.7.6）：对话页与 AI 面板监听这个事件，把选项当作用户的回答发出 */
export const REPLY_EVENT = 'jiwei:reply'
export type ReplyDetail = { conversationId: string; text: string; uiEvent?: UiEvent }
export function replyInConversation(conversationId: string, text: string, uiEvent?: UiEvent): void {
  window.dispatchEvent(new CustomEvent<ReplyDetail>(REPLY_EVENT, { detail: { conversationId, text, uiEvent } }))
}

/** AI 的选择题（ask_user）：只有最新一条回答上的可以点 */
function Choices({ step, conversationId, active }: { step: AgentStep; conversationId: string; active: boolean }) {
  const [picked, setPicked] = useState<string | null>(null)
  if (!step.choices) return null
  return (
    <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={step.choices.question} data-testid="ask-choices">
      {step.choices.options.map((o) => (
        <button
          key={o}
          disabled={!active || !!picked}
          onClick={() => {
            setPicked(o)
            replyInConversation(conversationId, o)
          }}
          className={cn(
            'rounded-full border px-3.5 py-1.5 text-sm transition-colors',
            picked === o
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-border bg-surface text-fg enabled:hover:border-accent/50 enabled:hover:bg-accent-soft/40 disabled:opacity-50'
          )}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

/** 依据（v0.7.6）：默认折叠成一行，不抢回答正文的视觉；展开后列出引用的笔记与资料片段 */
function Basis({ citations, conversationId }: { citations: Citation[]; conversationId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const c of citations) if (c.via) counts.set(c.via, (counts.get(c.via) ?? 0) + 1)
  const order = ['keyword', 'semantic', 'both', 'context'] as const
  const via = order
    .filter((k) => counts.get(k))
    .map((k) => `${t(`chat.via.${k}`)} ${counts.get(k)}`)
    .join(' · ')
  const web = citations.filter((c) => c.parentType === 'web').length,
    project = citations.filter((c) => c.projectSource).length,
    kb = citations.length - web - project
  const title = [
    kb || web ? t(`retrieval.basis.${kb && web ? 'both' : web ? 'web' : 'kb'}`, { kb, web }) : '',
    project ? `${t('projects.sourceBasis')} ${project}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="mt-3" data-testid="answer-basis">
      <Tip label={t('chat.basisHint')} side="top">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? t('chat.basisHide') : t('chat.basisShow')}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-subtle transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <Library className="size-3.5" />
          {title}
          {via && <span className="text-2xs text-subtle/80">· {via}</span>}
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        </button>
      </Tip>
      {open && (
        <div className="mt-1.5 rounded-xl border border-border bg-surface/60 py-1">
          {citations.map((c) => (
            <CitationCard key={c.n} c={c} conversationId={conversationId} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * compact：就地卡片中使用，隐藏用量信息。
 * plain：不是知识库问答（费曼练习、复盘追问），不显示“没有引用知识库”的提示。
 */
export function MessageItem({
  m,
  compact,
  replyRestricted,
  plain,
  grounded,
  last
}: {
  m: ChatMessage
  compact?: boolean
  replyRestricted?: boolean
  plain?: boolean
  grounded?: boolean
  /** 最新一条：其中的选择题可以点 */
  last?: boolean
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  useReplySelection(bodyRef, m.role === 'assistant' && !!m.content)
  const [threadsOpen, setThreadsOpen] = useState(false)
  const { data: threads = [] } = useQuery({
    queryKey: ['threads', m.id],
    queryFn: () => api.chat.threads(m.id),
    enabled: m.role === 'assistant' && m.status === 'done' && !plain
  })
  const byN = useMemo(() => new Map(m.citations.map((c) => [c.n, c])), [m.citations])
  // 引用标记 [n] → 可点击的编号（代码块中的不处理）
  const md = useMemo(() => {
    return annotateUiFences(mapOutsideFences(m.content, (p) => p.replace(/\[(\d{1,2})\]/g, '[$1](#cite-$1)')))
  }, [m.content])

  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="paper max-w-[78%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-fg shadow-[var(--shadow-1)]">
          {m.content}
          {!!m.attachments?.length && <MessageAttachments items={m.attachments} conversationId={m.conversationId} />}
        </div>
      </div>
    )
  }

  const streaming = m.status === 'streaming'
  const components = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const cite = href?.match(/^#cite-(\d+)$/)
      if (cite) return <CiteChip n={Number(cite[1])} citation={byN.get(Number(cite[1]))} conversationId={m.conversationId} />
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    }
  }
  const seconds = m.usage ? Math.round(m.usage.durationMs / 1000) : null
  const copy = (): void => {
    void navigator.clipboard.writeText(uiAnswerText(m.content).replace(/\[(\d{1,2})\]/g, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="group/msg">
      {m.reasoning && <Reasoning text={m.reasoning} streaming={streaming && !m.content} seconds={seconds} />}
      {m.steps.length > 0 && <Steps steps={m.steps} streaming={streaming} />}
      {m.content ? (
        <div
          ref={bodyRef}
          className="chat-md select-text"
          data-reply-id={plain ? undefined : m.id}
          data-conversation-id={m.conversationId}
          data-streaming={streaming ? 'true' : undefined}
          data-reply-restricted={replyRestricted ? 'true' : undefined}
        >
          <UiMessageProvider message={m} isLatest={!!last} compact={!!compact}>
            <Streamdown
              // 两种模式采用不同的块树；组件回答保持流式树，结束只停止动画，保留组件实例。
              mode={plain && !streaming ? 'static' : 'streaming'}
              isAnimating={streaming}
              components={components as never}
              controls={{ code: true, table: true, mermaid: false }}
              plugins={plain ? plainPlugins : uiPlugins}
            >
              {md}
            </Streamdown>
          </UiMessageProvider>
        </div>
      ) : (
        streaming && !m.reasoning && !m.steps.length && <div className="h-5 w-16 animate-pulse rounded bg-sunken" />
      )}
      {m.status === 'done' &&
        m.steps
          .filter((s) => s.choices)
          .slice(-1)
          .map((s) => <Choices key={s.id} step={s} conversationId={m.conversationId} active={!!last} />)}
      {m.status === 'error' && budgetKind(m.error) && <BudgetNotice error={m.error!} />}
      {m.status === 'error' && !budgetKind(m.error) && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-all">{m.error}</span>
        </div>
      )}
      {m.status === 'stopped' && <p className="mt-2 text-2xs text-subtle">{t('chat.stopped')}</p>}

      <MessageReadiness message={m} />
      {m.citations.length > 0 && <Basis conversationId={m.conversationId} citations={m.citations} />}
      {!plain &&
        !grounded &&
        m.status === 'done' &&
        !m.readiness?.length &&
        m.citations.length === 0 &&
        m.steps.length === 0 &&
        m.content && <p className="mt-2 text-2xs text-subtle">{t('chat.generalOnly')}</p>}

      {threads.length > 0 && !replyRestricted && (
        <div className="mt-2 text-xs text-muted">
          <button
            className="rounded px-1 py-1 hover:bg-sunken hover:text-accent"
            aria-expanded={threadsOpen}
            onClick={() => setThreadsOpen(!threadsOpen)}
          >
            {t('assist.replyThreads', { count: threads.length })}
          </button>
          {threadsOpen && (
            <div className="mt-1 space-y-1 rounded-lg border border-border p-2">
              {threads.map((thread) => (
                <button
                  key={thread.id}
                  className="block w-full rounded px-2 py-1 text-left hover:bg-sunken"
                  onClick={async (event) => {
                    const rect = elementRect(event.currentTarget)
                    const messages = await api.chat.messages(thread.id)
                    const question = messages.find((message) => message.role === 'user')?.content ?? thread.title
                    if (thread.anchor)
                      useAssist.getState().openCard({ anchor: thread.anchor, rect, conversationId: thread.id, action: 'ask', question })
                  }}
                >
                  <span className="block line-clamp-1 font-kai">{thread.anchor?.quote}</span>
                  <span className="block line-clamp-1 text-2xs text-subtle">{thread.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {!streaming && m.content && !compact && (
        <div className="mt-2 flex items-center gap-2 text-2xs text-subtle opacity-0 transition-opacity group-hover/msg:opacity-100">
          <button onClick={copy} className="inline-flex items-center gap-1 rounded px-1 hover:text-fg" aria-label={t('chat.copy')}>
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
          {m.model && <span className="font-mono">{m.model}</span>}
          {m.effort && <span>· {t('chat.effortLabel', { level: t(`ai.efforts.${m.effort}`) })}</span>}
          {m.usage && (
            <span>
              · {fmtTokens(m.usage.inputTokens)} → {fmtTokens(m.usage.outputTokens)} tokens
              {m.usage.reasoningTokens ? `（${t('chat.reasoningTokens', { n: fmtTokens(m.usage.reasoningTokens) })}）` : ''}
              {m.usage.cost !== null ? ` · ≈${money.format(m.usage.cost)}` : ''} · {(m.usage.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </div>
  )
}
