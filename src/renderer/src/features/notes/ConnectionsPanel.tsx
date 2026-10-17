import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpLeft, ChevronDown, FileText, Link2, NotebookText, Sparkles, X, AtSign, Plus, Crosshair } from 'lucide-react'
import type { NoteConnections } from '@shared/types'
import { toast } from 'sonner'
import { api, cn } from '@/lib/utils'
import { openSourceAt, useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import type { Relation } from '@shared/graphRelations'
import { relationOptions } from '@/features/graph/NodePanel'
import { SourceSelectorSchema, type SourceSelector } from '@shared/sourceTarget'
import { locatorFields } from '@shared/context'
import { textSelectionAnchor } from '../assist/actions'

// 笔记底部的「关联」：链接到这里（反向链接）、已关联、相关推荐（本地向量）、未链接的提及。
// 关联是双向的：在任意一方建立，两边都能看到。

const open = (type: 'note' | 'source', id: string, blockId?: string | null, selector?: SourceSelector): void => {
  const app = useApp.getState()
  if (type === 'note') {
    app.openNote(id)
    if (blockId) app.setHighlight({ type: 'block', id: blockId })
  } else if (selector) openSourceAt(id, new URLSearchParams({ target: JSON.stringify(selector) }))
  else app.openSource(id)
}

function Group({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <section className="mt-5 first:mt-0">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted [&_svg]:size-3.5 [&_svg]:text-accent">
        {icon}
        {title}
        <span className="text-subtle">{count}</span>
      </h4>
      <ul className="mt-2 space-y-1">{children}</ul>
    </section>
  )
}

export function ConnectionsPanel({ noteId }: { noteId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [collapsed, setCollapsed] = useState(false)
  const ctx = useApp((s) => s.context)
  const key = ['connections', noteId]
  const { data: c } = useQuery({ queryKey: key, queryFn: () => api.connections.get(noteId), staleTime: 0 })
  // 正文变化（新增链接）后刷新
  useEffect(() => {
    let timer: number | undefined
    const off = window.jiweiEvents.on('notes:changed', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['connections'] }), 800)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [qc])
  if (!c) return null
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['connections'] })
  const relate = (type: 'note' | 'source', id: string, selector?: SourceSelector): void =>
    void api.connections
      .relate(noteId, type, id, undefined, undefined, selector)
      .then(refresh)
      .catch((error) => toast.error(String(error)))
  const unrelate = (type: 'note' | 'source', id: string): void => void api.connections.unrelate(noteId, type, id).then(refresh)
  const recordRange = (sourceId: string): void => {
    const context = useApp.getState().context
    if (context.sourceId !== sourceId) return
    const anchor = textSelectionAnchor(sourceId)?.anchor
    const parsed = SourceSelectorSchema.safeParse({
      ownerId: context.sourceSegmentId,
      ...locatorFields(context.sourceLocator),
      ...(anchor ?? (context.sourceSelection ? { quote: context.sourceSelection } : {}))
    })
    if (!parsed.success) return void toast.error(t('links.rangeHelp'))
    void api.connections
      .relate(noteId, 'source', sourceId, undefined, undefined, parsed.data)
      .then(() => {
        refresh()
        toast.success(t('links.rangeSaved'))
      })
      .catch((error) => toast.error(String(error)))
  }
  // 把提及变成链接：直接在那篇笔记中给标题文字加上链接（可撤销）
  const linkMention = async (m: NoteConnections['mentions'][number]): Promise<void> => {
    const ok = await api.connections.linkMention(noteId, m.noteId, m.blockId)
    if (!ok) return void toast.error(t('links.makeLinkFailed'))
    toast.success(t('links.madeLink', { title: m.title }), {
      action: { label: t('memory.undo'), onClick: () => void api.connections.linkMention(noteId, m.noteId, m.blockId, true) }
    })
  }
  const total = c.backlinks.length + c.linked.length + c.related.length + c.mentions.length
  const Icon = ({ type }: { type: 'note' | 'source' }) => (type === 'note' ? <NotebookText /> : <FileText />)
  const row =
    'group flex items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-hover [&>svg]:mt-0.5 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-subtle'

  return (
    <section className="mt-8 rounded-2xl border border-border bg-surface/60 px-5 py-4" data-testid="connections">
      <button onClick={() => setCollapsed(!collapsed)} className="flex w-full items-center gap-2 text-left">
        <Link2 className="size-4 text-accent" />
        <h3 className="flex-1 text-sm font-medium text-fg">{t('links.title')}</h3>
        <span className="text-2xs text-subtle">{total ? t('links.count', { count: total }) : ''}</span>
        <ChevronDown className={cn('size-4 text-subtle transition-transform', collapsed && '-rotate-90')} />
      </button>
      {!collapsed && (
        <div className="mt-4">
          {total === 0 && <p className="text-xs leading-relaxed text-subtle">{c.vectors ? t('links.empty') : t('links.emptyNoVectors')}</p>}
          <Group icon={<ArrowUpLeft />} title={t('links.backlinks')} count={c.backlinks.length}>
            {c.backlinks.map((b, i) => (
              <li key={`${b.noteId}:${i}`}>
                <button onClick={() => open('note', b.noteId, b.blockId)} className={cn(row, 'w-full text-left')} data-backlink={b.title}>
                  <NotebookText />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{b.title || t('common.untitled')}</span>
                    {b.text && <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted">{b.text}</span>}
                  </span>
                </button>
              </li>
            ))}
          </Group>
          <Group icon={<Link2 />} title={t('links.linked')} count={c.linked.length}>
            {c.linked.map((l) => (
              <li key={l.linkId} className={row} data-linked={l.title}>
                <Icon type={l.type} />
                <button
                  onClick={() => {
                    open(l.type, l.id, undefined, l.selector)
                    if (l.type === 'source' && !l.selector) toast.info(t('links.noRange'))
                  }}
                  className="min-w-0 flex-1 truncate text-left text-sm text-fg hover:text-accent"
                >
                  {l.title || t('common.untitled')}
                </button>
                {l.type === 'source' && (
                  <Tip label={t('links.rangeHelp')}>
                    <button
                      aria-label={t('links.recordRange', { title: l.title })}
                      disabled={ctx.sourceId !== l.id || !(ctx.sourceSelection || ctx.sourceSegmentId || ctx.sourceLocator)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => recordRange(l.id)}
                      className="grid size-5 shrink-0 place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:text-accent focus:opacity-100 disabled:opacity-30 [&_svg]:size-3.5"
                    >
                      <Crosshair />
                    </button>
                  </Tip>
                )}
                {/* 关系类型（v0.14.2）：前置、推出、对比……在知识图谱上会按类型画出来 */}
                {l.type === 'note' && (
                  <select
                    aria-label={`${t('graph.setType')}：${l.title}`}
                    value={`${l.relation}|${l.relation === 'related' || l.outgoing ? 0 : 1}`}
                    onChange={(e) => {
                      const [r, rev] = e.target.value.split('|')
                      void api.connections.relate(noteId, 'note', l.id, r as Relation, rev === '1').then(refresh)
                    }}
                    className="max-w-40 shrink-0 truncate rounded-md border border-transparent bg-transparent px-1 py-0.5 text-2xs text-subtle hover:border-border focus:border-border"
                  >
                    {relationOptions(t('links.thisNote'), l.title || t('common.untitled'), i18n.language.startsWith('zh')).map((o) => (
                      <option key={o.value} value={o.value} title={o.title}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
                <Tip label={t('links.unrelate')}>
                  <button
                    aria-label={`${t('links.unrelate')}：${l.title}`}
                    onClick={() => unrelate(l.type, l.id)}
                    className="grid size-5 place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:text-danger [&_svg]:size-3.5"
                  >
                    <X />
                  </button>
                </Tip>
              </li>
            ))}
          </Group>
          <Group icon={<Sparkles />} title={t('links.related')} count={c.related.length}>
            {c.related.map((r: NoteConnections['related'][number]) => (
              <li key={`${r.type}:${r.id}`} className={row} data-related={r.title}>
                <Icon type={r.type} />
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => open(r.type, r.id, undefined, r.selector)}
                    className="block max-w-full truncate text-left text-sm text-fg hover:text-accent"
                  >
                    {r.title || t('common.untitled')}
                  </button>
                  {r.theirs && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{r.theirs}</p>}
                  {r.mine && <p className="mt-0.5 line-clamp-1 text-2xs text-subtle">{t('links.similarTo', { text: r.mine })}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" onClick={() => relate(r.type, r.id, r.selector)}>
                    <Plus />
                    {t('links.relate')}
                  </Button>
                  <Tip label={t('links.dismiss')}>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${t('links.dismiss')}：${r.title}`}
                      onClick={() => unrelate(r.type, r.id)}
                    >
                      <X />
                    </Button>
                  </Tip>
                </div>
              </li>
            ))}
          </Group>
          <Group icon={<AtSign />} title={t('links.mentions')} count={c.mentions.length}>
            {c.mentions.map((m) => (
              <li key={m.noteId} className={row} data-mention={m.title}>
                <NotebookText />
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => open('note', m.noteId, m.blockId)}
                    className="block max-w-full truncate text-left text-sm text-fg hover:text-accent"
                  >
                    {m.title || t('common.untitled')}
                  </button>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{m.text}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" onClick={() => void linkMention(m)}>
                    <Link2 />
                    {t('links.makeLink')}
                  </Button>
                  <Tip label={t('links.relateHint')}>
                    <Button size="sm" variant="ghost" onClick={() => relate('note', m.noteId)}>
                      {t('links.relate')}
                    </Button>
                  </Tip>
                </div>
              </li>
            ))}
          </Group>
        </div>
      )}
    </section>
  )
}
