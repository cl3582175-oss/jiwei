import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { generateHTML } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import type * as Y from 'yjs'
import { toast } from 'sonner'
import { Sparkles, Check, X, BookOpen, Network } from 'lucide-react'
import type { Proposal, ProposalOp } from '@shared/types'
import { embedText } from '@shared/embeds'
import { api, cn, formatRelative } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { applyOp, ProposalTargetMissing } from './editor/applyProposal'
import { previewExtensions } from './editor/preview'

/** AI 修改提案面板：逐条预览、接受或拒绝；接受的内容以 AI 来源写入，可撤销 */
export function ProposalPanel({ noteId, editor, ydoc }: { noteId: string; editor: Editor | null; ydoc: Y.Doc | null }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const key = ['proposals', noteId]
  const { data: list = [] } = useQuery({ queryKey: key, queryFn: () => api.proposals.list(noteId) })

  useEffect(
    () =>
      window.jiweiEvents.on('proposals:changed', (p) => {
        if (p.noteId === noteId) void qc.invalidateQueries({ queryKey: key })
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [noteId, qc]
  )

  // 预览用的只读 schema（与编辑器一致，富内容块以占位方式渲染）
  const extensions = useMemo(() => previewExtensions({ summary: t('notes.summary'), cueHint: '', bodyHint: '', summaryHint: '' }), [t])
  const html = (nodes: unknown[]): string => {
    try {
      return generateHTML(
        {
          type: 'doc',
          content: [
            {
              type: 'cornellRow',
              content: [
                { type: 'cornellCue', content: [{ type: 'paragraph' }] },
                { type: 'cornellBody', content: nodes }
              ]
            },
            { type: 'cornellSummary', content: [{ type: 'paragraph' }] }
          ]
        } as never,
        extensions
      )
    } catch {
      return ''
    }
  }

  const decide = async (p: Proposal, i: number, decision: 'accepted' | 'rejected'): Promise<void> => {
    if (decision === 'accepted') {
      if (!editor || !ydoc) return
      try {
        applyOp(editor, ydoc, p, p.ops[i])
      } catch (e) {
        toast.error(e instanceof ProposalTargetMissing ? t('proposals.targetMissing') : String(e))
        return
      }
    }
    await api.proposals.resolve(p.id, i, decision)
    void qc.invalidateQueries({ queryKey: key })
  }

  const decideAll = async (p: Proposal, decision: 'accepted' | 'rejected'): Promise<void> => {
    for (let i = 0; i < p.ops.length; i++) if (p.opStatus[i] === 'pending') await decide(p, i, decision)
  }

  if (list.length === 0) return null

  const opLabel = (op: ProposalOp): string => t(`proposals.op.${op.op}`)
  const preview = (p: Proposal, op: ProposalOp): React.ReactNode => {
    const nodes = op.op === 'insert_row' ? [...op.cue, ...op.body] : 'nodes' in op ? op.nodes : []
    const embeds = (nodes as { type: string; attrs?: { id?: string } }[]).filter((n) => n.type === 'embed')
    if (embeds.length) {
      return embeds.map((n) => {
        const e = p.embeds[n.attrs?.id ?? '']
        return (
          <pre key={n.attrs?.id} className="proposal-embed">
            <Network className="mb-1 size-3.5 text-accent" />
            {e ? embedText(e.kind, e.data) : '—'}
          </pre>
        )
      })
    }
    if (op.op === 'delete_block') return <p className="text-xs text-subtle">{t('proposals.deleteHint')}</p>
    return <div className="proposal-preview prose-jiwei" dangerouslySetInnerHTML={{ __html: html(nodes) }} />
  }

  return (
    <div className="mb-6 space-y-3">
      {list.map((p) => (
        <section key={p.id} className="overflow-hidden rounded-xl border border-accent/30 bg-accent-soft/40 shadow-card">
          <header className="flex items-center gap-2.5 border-b border-accent/20 px-4 py-2.5">
            <Sparkles className="size-4 text-accent" />
            <span className="flex-1 truncate text-sm font-medium text-fg">{p.title}</span>
            <span className="text-2xs text-subtle">
              {p.model ? `${p.model} · ` : ''}
              {formatRelative(p.createdAt, i18n.language)}
            </span>
          </header>
          <ol className="divide-y divide-accent/15">
            {p.ops.map((op, i) => (
              <li key={i} className={cn('flex gap-3 px-4 py-3', p.opStatus[i] !== 'pending' && 'opacity-45')}>
                <span className="mt-0.5 shrink-0 rounded bg-surface px-1.5 py-0.5 text-2xs text-muted">{opLabel(op)}</span>
                <div className="min-w-0 flex-1">{preview(p, op)}</div>
                {p.opStatus[i] === 'pending' ? (
                  <div className="flex shrink-0 items-start gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-accent hover:bg-accent-soft hover:text-accent"
                      onClick={() => void decide(p, i, 'accepted')}
                      aria-label={t('proposals.accept')}
                    >
                      <Check />
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => void decide(p, i, 'rejected')} aria-label={t('proposals.reject')}>
                      <X />
                    </Button>
                  </div>
                ) : (
                  <span className="shrink-0 text-2xs text-subtle">{t(`proposals.${p.opStatus[i]}`)}</span>
                )}
              </li>
            ))}
          </ol>
          <footer className="flex items-center justify-between gap-2 border-t border-accent/20 px-4 py-2">
            <span className="flex items-center gap-1.5 text-2xs text-subtle">
              {p.sources?.length ? (
                <>
                  <BookOpen className="size-3" />
                  {t('proposals.sources', { count: p.sources.length })}
                </>
              ) : null}
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => void decideAll(p, 'rejected')}>
                {t('proposals.rejectAll')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void decideAll(p, 'accepted')}>
                <Check />
                {t('proposals.acceptAll')}
              </Button>
            </div>
          </footer>
        </section>
      ))}
    </div>
  )
}
