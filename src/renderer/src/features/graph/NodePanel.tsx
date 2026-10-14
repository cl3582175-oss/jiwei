import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Crosshair, ExternalLink, Plus, X } from 'lucide-react'
import type { GraphEdge, GraphNode, KnowledgeGraph } from '@shared/types'
import { RELATIONS, RELATION_META, relationSentence, type Relation } from '@shared/graphRelations'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { type Tokens } from '@/features/visuals/tokens'
import { statusColor } from '../review/MasteryView'
import { edgeStyle, otherEnd } from './model'

/**
 * 关系选择项：value 为 “关系|是否反向”。有方向的关系给出两个方向，标签写成“前置 · 甲 → 乙”（箭头与图上一致），
 * 完整句子放在 title 里。
 */
export function relationOptions(self: string, other: string, zh: boolean): { value: string; label: string; title: string }[] {
  const short = (s: string): string => (s.length > 10 ? `${s.slice(0, 9)}…` : s)
  return RELATIONS.flatMap((r) => {
    const m = RELATION_META[r],
      name = zh ? m.zh : m.en
    if (m.arrow === 'none') return [{ value: `${r}|0`, label: name, title: relationSentence(r, self, other, zh) }]
    return ([false, true] as const).map((rev) => {
      const [a, b] = rev ? [other, self] : [self, other]
      const [p, q] = m.arrow === 'forward' ? [a, b] : [b, a]
      return { value: `${r}|${rev ? 1 : 0}`, label: `${name} · ${short(p)} → ${short(q)}`, title: relationSentence(r, a, b, zh) }
    })
  })
}
const parse = (value: string): [Relation, boolean] => {
  const [r, rev] = value.split('|')
  return [r as Relation, rev === '1']
}

export function NodePanel({
  node,
  graph,
  edges,
  c,
  catColor,
  hub,
  onOpen,
  onFocus,
  onSelect,
  onClose,
  onChanged
}: {
  node: GraphNode
  graph: KnowledgeGraph
  edges: GraphEdge[]
  c: Tokens
  catColor: Map<string, string>
  hub: boolean
  onOpen(): void
  onFocus(): void
  onSelect(key: string): void
  onClose(): void
  onChanged(): void
}) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const byKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph])
  const title = (key: string): string => byKey.get(key)?.title || t('common.untitled')
  const mine = edges.filter((e) => e.from === node.key || e.to === node.key)
  const [q, setQ] = useState('')
  const [target, setTarget] = useState<GraphNode | null>(null)
  const [choice, setChoice] = useState('related|0')
  const neighbours = new Set(mine.map((e) => otherEnd(e, node.key)))
  const matches = q.trim()
    ? graph.nodes
        .filter(
          (n) => n.type === 'note' && n.key !== node.key && !neighbours.has(n.key) && n.title.toLowerCase().includes(q.trim().toLowerCase())
        )
        .slice(0, 6)
    : []
  const category = graph.categories.find((cat) => cat.id === node.categoryId)
  const set = async (other: GraphNode, value: string): Promise<void> => {
    const [relation, reverse] = parse(value)
    await api.connections.relate(node.id, other.type, other.id, relation, reverse)
    onChanged()
  }
  return (
    <aside
      data-testid="graph-panel"
      className="paper absolute top-4 right-4 bottom-24 flex w-80 flex-col overflow-hidden rounded-xl shadow-[var(--shadow-2)]"
    >
      <header className="border-b border-border/70 px-4 pt-3.5 pb-3">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 font-serif text-base leading-snug font-semibold text-fg">{node.title || t('common.untitled')}</h2>
          <button aria-label={t('graph.clear')} onClick={onClose} className="mt-0.5 text-subtle hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
          {node.type === 'source' ? (
            <span className="rounded-full border border-border px-2 py-0.5">{t('graph.legend.source')}</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5">
              <span className="size-2 rounded-full" style={{ background: category ? catColor.get(category.id) : c.subtle }} />
              {category?.name ?? t('graph.legend.uncategorized')}
            </span>
          )}
          {node.mastery && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5">
              <span className="size-2 rounded-full" style={{ background: statusColor(node.mastery, c) }} />
              {t(`mastery.status.${node.mastery}`)}
            </span>
          )}
          {hub && <span className="rounded-full bg-emph-soft px-2 py-0.5 text-emph">{t('graph.legend.hub')}</span>}
          {node.status && node.status !== 'active' && (
            <span className="rounded-full bg-viz-4/10 px-2 py-0.5 text-viz-4">{t(`graph.${node.status}`)}</span>
          )}
          <span>{t('graph.links', { n: mine.length })}</span>
        </div>
        {node.excerpt && <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted">{node.excerpt}</p>}
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={onOpen}>
            <ExternalLink className="size-3.5" />
            {t('graph.open')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onFocus}>
            <Crosshair className="size-3.5" />
            {t('graph.focusHere')}
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="mb-2 text-2xs font-medium tracking-wide text-subtle">{t('graph.relations')}</p>
        {!mine.length && <p className="text-xs text-muted">{t('graph.noRelations')}</p>}
        <ul className="space-y-2.5" data-testid="graph-relations">
          {mine.map((e) => {
            const other = byKey.get(otherEnd(e, node.key))
            if (!other) return null
            const style = edgeStyle(e, c)
            const sentence =
              e.kind === 'source' || e.relation === 'related'
                ? `${title(node.key)} — ${other.title}`
                : relationSentence(e.relation, title(e.from), title(e.to), zh)
            const value = e.relation === 'related' ? 'related|0' : `${e.relation}|${e.from === node.key ? 0 : 1}`
            return (
              <li key={`${e.from}|${e.to}`} className="rounded-lg border border-border/70 p-2.5">
                <div className="flex items-start gap-2">
                  <span className="mt-[7px] h-[3px] w-4 shrink-0 rounded-full" style={{ background: style.color }} aria-hidden="true" />
                  <button
                    className="min-w-0 flex-1 text-left text-xs leading-relaxed text-fg hover:text-accent"
                    onClick={() => onSelect(other.key)}
                  >
                    {sentence}
                  </button>
                  {e.kind === 'related' && node.type === 'note' && (
                    <button
                      aria-label={t('graph.remove')}
                      title={t('graph.remove')}
                      className="text-subtle hover:text-fg"
                      onClick={async () => {
                        await api.connections.unrelate(node.id, other.type, other.id)
                        onChanged()
                      }}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-6 text-2xs text-subtle">
                  <span>
                    {e.kind === 'reference' ? t('graph.textLink') : e.status === 'suggested' ? t('graph.suggested') : t('graph.manual')}
                  </span>
                  {node.type === 'note' && other.type === 'note' && (
                    <select
                      aria-label={t('graph.setType')}
                      value={value}
                      onChange={(ev) => void set(other, ev.target.value)}
                      className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-1.5 py-1 text-2xs text-fg"
                    >
                      {relationOptions(title(node.key), other.title, zh).map((o) => (
                        <option key={o.value} value={o.value} title={o.title}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        {node.type === 'note' && (
          <div className="mt-4 border-t border-border/70 pt-3">
            <p className="mb-2 text-2xs font-medium tracking-wide text-subtle">{t('graph.addRelation')}</p>
            {target ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-fg">{target.title}</span>
                  <button aria-label={t('graph.clear')} onClick={() => setTarget(null)} className="text-subtle hover:text-fg">
                    <X className="size-3.5" />
                  </button>
                </div>
                <select
                  aria-label={t('graph.setType')}
                  value={choice}
                  onChange={(ev) => setChoice(ev.target.value)}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg"
                >
                  {relationOptions(title(node.key), target.title, zh).map((o) => (
                    <option key={o.value} value={o.value} title={o.title}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  onClick={async () => {
                    await set(target, choice)
                    setTarget(null)
                    setQ('')
                    setChoice('related|0')
                  }}
                >
                  <Plus className="size-3.5" />
                  {t('graph.add')}
                </Button>
              </div>
            ) : (
              <>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('graph.addPlaceholder')}
                  aria-label={t('graph.addPlaceholder')}
                  className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-xs text-fg outline-none placeholder:text-subtle focus:border-accent"
                />
                {matches.length > 0 && (
                  <ul className="mt-1 overflow-hidden rounded-md border border-border">
                    {matches.map((n) => (
                      <li key={n.key}>
                        <button
                          className={cn('w-full truncate px-2.5 py-1.5 text-left text-xs text-fg hover:bg-surface-hover')}
                          onClick={() => setTarget(n)}
                        >
                          {n.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
