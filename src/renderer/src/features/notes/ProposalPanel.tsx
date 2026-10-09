import { applyInboxToEditor } from '../inbox/documents'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { generateHTML } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import * as Y from 'yjs'
import { toast } from 'sonner'
import { Sparkles, Check, X, BookOpen, Network } from 'lucide-react'
import { DOC_FIELD, type Proposal, type ProposalOp } from '@shared/types'
import { embedText } from '@shared/embeds'
import { api, cn, formatRelative } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { applyOp, ProposalTargetMissing } from './editor/applyProposal'
import { diffKey, DIFF_DECISION, type DiffDecision, type DiffItem } from './editor/proposalDiff'
import { embedViews } from './editor/embeds/registry'
import { embedsMap, writeEmbed } from './editor/embeds/ydata'
import { previewExtensions } from './editor/preview'

/** AI 修改提案面板：逐条预览、接受或拒绝；接受的内容以 AI 来源写入，可撤销 */
/** 富内容块预览：用真正的显示组件渲染（导图、图表、图示……），数据放在临时的 Yjs 文档中 */
function EmbedPreview({ kind, data }: { kind: string; data: unknown }) {
  const entry = useMemo(() => {
    const doc = new Y.Doc()
    writeEmbed(doc, 'preview', kind, data)
    return embedsMap(doc).get('preview') as Y.Map<unknown>
  }, [kind, data])
  const View = embedViews[kind].View
  return (
    <div className="proposal-embed-live overflow-hidden rounded-lg border border-border bg-surface">
      <View entry={entry} id="preview" editable={false} />
    </div>
  )
}

/** 文档 JSON 的纯文本（块之间换行） */
function jsonText(nodes: unknown[]): string {
  const out: string[] = []
  const walk = (n: { type?: string; text?: string; content?: unknown[] }, block: boolean): string => {
    if (n.type === 'text') return n.text ?? ''
    const inner = (n.content ?? [])
      .map((c) => walk(c as never, false))
      .join(n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'listItem' || n.type === 'blockquote' ? '\n' : '')
    if (block) out.push(inner)
    return inner
  }
  for (const n of nodes) walk(n as never, true)
  return out.join('\n')
}

export function ProposalPanel({ noteId, editor, ydoc }: { noteId: string; editor: Editor | null; ydoc: Y.Doc | null }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const key = ['proposals', noteId]
  // 打开笔记时总是重新读取：笔记没打开期间（如费曼练习、存入笔记）新增的提案不会经过下面的事件监听
  const { data: list = [] } = useQuery({ queryKey: key, queryFn: () => api.proposals.list(noteId), staleTime: 0 })

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
    let blockIds: string[] | undefined
    if (decision === 'accepted') {
      if (!editor || !ydoc) return
      try {
        blockIds = applyOp(editor, ydoc, p, p.ops[i])
      } catch (e) {
        toast.error(e instanceof ProposalTargetMissing ? t('proposals.targetMissing') : String(e))
        return
      }
    }
    await api.proposals.resolve(p.id, i, decision, blockIds)
    void qc.invalidateQueries({ queryKey: key })
  }

  const decideAll = async (p: Proposal, decision: 'accepted' | 'rejected'): Promise<void> => {
    if (p.skill === 'inbox' && decision === 'accepted' && editor && ydoc) { await applyInboxToEditor(editor, ydoc, p); return }
    for (let i = 0; i < p.ops.length; i++) if (p.opStatus[i] === 'pending') await decide(p, i, decision)
  }

  // 用户主动操作产生的写入（如“存入笔记”）：编辑器与 Yjs 内容同步完成后直接应用。
  // y-prosemirror 在编辑器创建后才把文档内容同步进来；过早应用会写到占位文档上。
  const applying = useRef(new Set<string>())
  useEffect(() => {
    if (!editor || !ydoc || !list.some((p) => p.auto && !applying.current.has(p.id))) return
    let tries = 0
    let timer = 0
    const run = (): void => {
      if (editor.isDestroyed) return
      const first = ydoc.getXmlFragment(DOC_FIELD).get(0)
      const yId = first instanceof Y.XmlElement ? first.getAttribute('id') : undefined
      const synced = !yId || editor.state.doc.firstChild?.attrs.id === yId
      if (!synced && tries++ < 40) {
        timer = window.setTimeout(run, 50)
        return
      }
      for (const p of list) {
        if (!p.auto || applying.current.has(p.id)) continue
        applying.current.add(p.id)
        void decideAll(p, 'accepted').catch((e: Error) => { applying.current.delete(p.id); toast.error(e.message) })
      }
    }
    run()
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, editor, ydoc])

  // 文档版本：接受一条修改后重新计算其余差异的位置（只在有待定修改时监听）
  const [docVersion, setDocVersion] = useState(0)
  const hasPending = list.some((p) => !p.auto && p.status === 'pending')
  useEffect(() => {
    if (!editor || !hasPending) return
    const bump = (): void => setDocVersion((v) => v + 1)
    editor.on('update', bump)
    return () => {
      editor.off('update', bump)
    }
  }, [editor, hasPending])

  // 行内差异：替换 / 删除段落直接显示在笔记原文处（新内容不含富内容块、目标仍在文档中）
  const inline = useMemo(() => {
    const items: DiffItem[] = []
    const doc = editor?.state.doc
    if (!doc) return items
    const ids = new Set<string>()
    doc.descendants((n) => {
      if (typeof n.attrs.id === 'string') ids.add(n.attrs.id)
    })
    for (const p of list) {
      if (p.auto) continue
      p.ops.forEach((op, i) => {
        if (p.opStatus[i] !== 'pending') return
        if (op.op === 'replace_block' && ids.has(op.blockId) && !JSON.stringify(op.nodes).includes('"embed"'))
          items.push({ proposalId: p.id, opIndex: i, blockId: op.blockId, kind: 'replace', title: p.title, newText: jsonText(op.nodes) })
        else if (op.op === 'delete_block' && ids.has(op.blockId))
          items.push({ proposalId: p.id, opIndex: i, blockId: op.blockId, kind: 'delete', title: p.title })
      })
    }
    return items
    // 文档变化（如接受了其中一条）后重新计算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, editor, docVersion])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(diffKey, inline).setMeta('addToHistory', false))
  }, [editor, inline])

  // 差异卡片上的接受 / 拒绝
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<DiffDecision>).detail
      const p = list.find((x) => x.id === d.proposalId)
      if (p) void decide(p, d.opIndex, d.decision)
    }
    window.addEventListener(DIFF_DECISION, on)
    return () => window.removeEventListener(DIFF_DECISION, on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, editor, ydoc])

  const inlineKeys = new Set(inline.map((x) => `${x.proposalId}:${x.opIndex}`))
  // 所有待定操作都已在原文处显示的提案，不再出现在面板中
  const visible = list.filter((p) => !p.auto && p.ops.some((_, i) => p.opStatus[i] === 'pending' && !inlineKeys.has(`${p.id}:${i}`)))
  if (visible.length === 0) return null

  const opLabel = (op: ProposalOp): string => t(`proposals.op.${op.op}`)
  const preview = (p: Proposal, op: ProposalOp): React.ReactNode => {
    const nodes = op.op === 'insert_row' ? [...op.cue, ...op.body] : 'nodes' in op ? op.nodes : []
    const embeds = (nodes as { type: string; attrs?: { id?: string } }[]).filter((n) => n.type === 'embed')
    if (embeds.length) {
      return embeds.map((n) => {
        const e = p.embeds[n.attrs?.id ?? '']
        return e && embedViews[e.kind] ? (
          <EmbedPreview key={n.attrs?.id} kind={e.kind} data={e.data} />
        ) : (
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
      {visible.map((p) => (
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
              <Button size="sm" variant="primary" onClick={() => void decideAll(p, 'accepted').catch((e: Error) => { applying.current.delete(p.id); toast.error(e.message) })}>
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
