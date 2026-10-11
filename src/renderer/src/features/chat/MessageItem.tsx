import { useMemo, useState, type ReactNode } from 'react'
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
  ArrowUpRight
} from 'lucide-react'
import type { AgentStep, ChatMessage, Citation } from '@shared/types'
import { cn, formatDate } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Tip } from '@/components/ui/primitives'
import { ApprovalCard, BudgetNotice, StepLinkButton, budgetKind } from '@/features/agent/ChatCards'

/** 打开引用：笔记定位到段落，资料定位到片段 / 页码 */
export function openCitation(c: Citation): void {
  const s = useApp.getState()
  s.setHighlight({ type: c.parentType === 'note' ? 'block' : 'segment', id: c.ownerId, locator: c.locator })
  if (c.parentType === 'note') s.openNote(c.parentId)
  else s.openSource(c.parentId)
}

function CiteChip({ n, citation }: { n: number; citation?: Citation }) {
  if (!citation) return <sup className="text-subtle">[{n}]</sup>
  return (
    <Tip label={`${citation.title} · ${citation.snippet.slice(0, 60)}…`} side="top">
      <button onClick={() => openCitation(citation)} className="cite-chip" aria-label={`[${n}] ${citation.title}`}>
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

function CitationCard({ c }: { c: Citation }) {
  const { t, i18n } = useTranslation()
  const date = c.parentType === 'note' ? c.updatedAt : (c.learnedAt ?? c.updatedAt)
  return (
    <button
      onClick={() => openCitation(c)}
      className="group flex w-full gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover"
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-accent-soft font-mono text-2xs text-accent">{c.n}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs text-fg">
          {c.parentType === 'note' ? (
            <NotebookText className="size-3.5 shrink-0 text-subtle" />
          ) : (
            <FileText className="size-3.5 shrink-0 text-subtle" />
          )}
          <span className="truncate font-medium">{c.title || t('common.untitled')}</span>
          {c.locator && <span className="shrink-0 text-2xs text-subtle">{c.locator.replace('page=', 'p.').replace('chapter=', '§')}</span>}
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
          <span className="ml-auto shrink-0 text-2xs text-subtle">{date ? formatDate(date, i18n.language) : ''}</span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-2xs leading-relaxed text-muted">{c.snippet.replace(/^#{1,6}\s+/gm, '')}</span>
      </span>
    </button>
  )
}

/**
 * compact：就地卡片中使用，隐藏用量信息。
 * plain：不是知识库问答（费曼练习、复盘追问），不显示“没有引用知识库”的提示。
 */
export function MessageItem({ m, compact, plain, grounded }: { m: ChatMessage; compact?: boolean; plain?: boolean; grounded?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const byN = useMemo(() => new Map(m.citations.map((c) => [c.n, c])), [m.citations])
  // 引用标记 [n] → 可点击的编号（代码块中的不处理）
  const md = useMemo(() => {
    const parts = m.content.split(/(```[\s\S]*?(?:```|$))/g)
    return parts.map((p, i) => (i % 2 ? p : p.replace(/\[(\d{1,2})\]/g, '[$1](#cite-$1)'))).join('')
  }, [m.content])

  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="paper max-w-[78%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-fg shadow-[var(--shadow-1)]">
          {m.content}
        </div>
      </div>
    )
  }

  const streaming = m.status === 'streaming'
  const components = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const cite = href?.match(/^#cite-(\d+)$/)
      if (cite) return <CiteChip n={Number(cite[1])} citation={byN.get(Number(cite[1]))} />
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    }
  }
  const seconds = m.usage ? Math.round(m.usage.durationMs / 1000) : null
  const copy = (): void => {
    void navigator.clipboard.writeText(m.content.replace(/\[(\d{1,2})\]/g, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="group/msg">
      {m.reasoning && <Reasoning text={m.reasoning} streaming={streaming && !m.content} seconds={seconds} />}
      {m.steps.length > 0 && <Steps steps={m.steps} streaming={streaming} />}
      {m.content ? (
        <div className="chat-md">
          <Streamdown
            mode={streaming ? 'streaming' : 'static'}
            isAnimating={streaming}
            components={components as never}
            controls={{ code: true, table: true, mermaid: false }}
          >
            {md}
          </Streamdown>
        </div>
      ) : (
        streaming && !m.reasoning && !m.steps.length && <div className="h-5 w-16 animate-pulse rounded bg-sunken" />
      )}
      {m.status === 'error' && budgetKind(m.error) && <BudgetNotice error={m.error!} />}
      {m.status === 'error' && !budgetKind(m.error) && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-all">{m.error}</span>
        </div>
      )}
      {m.status === 'stopped' && <p className="mt-2 text-2xs text-subtle">{t('chat.stopped')}</p>}

      {m.citations.length > 0 && (
        <div className="mt-3 rounded-xl border border-border bg-surface/60 py-1">
          <p className="px-3 pt-1.5 pb-0.5 text-2xs tracking-wide text-subtle">{t('chat.fromKb', { count: m.citations.length })}</p>
          {m.citations.map((c) => (
            <CitationCard key={c.n} c={c} />
          ))}
        </div>
      )}
      {!plain && !grounded && m.status === 'done' && m.citations.length === 0 && m.steps.length === 0 && m.content && (
        <p className="mt-2 text-2xs text-subtle">{t('chat.generalOnly')}</p>
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
              {m.usage.cost !== null ? ` · ≈$${m.usage.cost.toFixed(4)}` : ''} · {(m.usage.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </div>
  )
}
