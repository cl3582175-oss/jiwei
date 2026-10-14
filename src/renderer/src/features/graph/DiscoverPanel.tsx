import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, MessageCircleQuestion, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import type { KnowledgeGraph } from '@shared/types'
import { relationSentence } from '@shared/graphRelations'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import type { Tokens } from '../visuals/tokens'
import { edgeStyle, knowledgeGaps } from './model'

// 整理与发现（v0.14.3）：AI 关系建议（确认后才算数）+ 知识缺口（孤立笔记、少与外界相连的分类、缺桥的两个分类）。
// 缺口可以一键变成问题发给积微助手。参考 InfraNodus 的结构缺口。

export function DiscoverPanel({
  graph,
  c,
  catColor,
  onSelect,
  onClose,
  onChanged
}: {
  graph: KnowledgeGraph
  c: Tokens
  catColor: Map<string, string>
  onSelect(key: string): void
  onClose(): void
  onChanged(): void
}) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const [busy, setBusy] = useState(false)
  const byKey = useMemo(() => new Map(graph.nodes.map((n) => [n.key, n])), [graph])
  const title = (key: string): string => byKey.get(key)?.title || t('common.untitled')
  const suggestions = graph.edges.filter((e) => e.status === 'suggested' && e.linkId)
  const gaps = useMemo(() => knowledgeGaps(graph), [graph])
  const catName = (id: string): string => graph.categories.find((cat) => cat.id === id)?.name ?? ''
  const ask = (question: string): void => useApp.getState().askAssistant(question)
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.graph.suggest()
      toast.success(r.judged ? t('graph.discover.done', { judged: r.judged, suggested: r.suggested }) : t('graph.discover.nothing'))
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <aside
      data-testid="graph-discover"
      className="paper absolute top-4 right-4 bottom-24 flex w-80 flex-col overflow-hidden rounded-xl shadow-[var(--shadow-2)]"
    >
      <header className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <Sparkles className="size-4 text-accent" />
        <h2 className="flex-1 text-sm font-semibold text-fg">{t('graph.discover.title')}</h2>
        <button aria-label={t('graph.clear')} onClick={onClose} className="text-subtle hover:text-fg">
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3">
        <section>
          <div className="mb-2 flex items-center gap-2">
            <p className="flex-1 text-2xs font-medium tracking-wide text-subtle">
              {t('graph.discover.suggestions', { n: suggestions.length })}
            </p>
            {suggestions.length > 1 && (
              <button
                className="text-2xs text-accent hover:underline"
                onClick={async () => {
                  await api.graph.acceptAll()
                  onChanged()
                }}
              >
                {t('graph.discover.acceptAll')}
              </button>
            )}
          </div>
          <p className="mb-2 text-xs leading-relaxed text-muted">{t('graph.discover.intro')}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()} data-testid="graph-suggest">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {busy ? t('graph.discover.running') : t('graph.discover.run')}
          </Button>
          <ul className="mt-3 space-y-2" data-testid="graph-suggestions">
            {suggestions.map((e) => (
              <li key={e.linkId} className="rounded-lg border border-dashed border-border-strong p-2.5">
                <div className="flex items-start gap-2">
                  <span
                    className="mt-[7px] h-[3px] w-4 shrink-0 rounded-full"
                    style={{ background: edgeStyle({ ...e, status: 'confirmed' }, c).color }}
                  />
                  <button
                    className="min-w-0 flex-1 text-left text-xs leading-relaxed text-fg hover:text-accent"
                    onClick={() => onSelect(e.from)}
                  >
                    {relationSentence(e.relation, title(e.from), title(e.to), zh)}
                  </button>
                </div>
                {e.reason && <p className="mt-1 pl-6 text-2xs leading-relaxed text-muted">{e.reason}</p>}
                <div className="mt-2 flex gap-1.5 pl-6">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await api.graph.accept(e.linkId!)
                      onChanged()
                    }}
                  >
                    <Check className="size-3.5" />
                    {t('graph.discover.accept')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api.graph.reject(e.linkId!)
                      onChanged()
                    }}
                  >
                    {t('graph.discover.reject')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section data-testid="graph-gaps">
          <p className="mb-2 text-2xs font-medium tracking-wide text-subtle">{t('graph.discover.gaps')}</p>
          {!gaps.bridges.length && !gaps.lonely.length && !gaps.isolated.length && (
            <p className="text-xs text-muted">{t('graph.discover.noGaps')}</p>
          )}
          {gaps.bridges.map((b) => {
            const q = t('graph.discover.bridgeQuestion', { a: b.from.title, b: b.to.title })
            return (
              <div key={`${b.a}|${b.b}`} className="mb-2 rounded-lg bg-sunken p-2.5 text-xs">
                <p className="flex items-center gap-1.5 text-fg">
                  <span className="size-2 rounded-full" style={{ background: catColor.get(b.a) }} />
                  {catName(b.a)}
                  <span className="text-subtle">↔</span>
                  <span className="size-2 rounded-full" style={{ background: catColor.get(b.b) }} />
                  {catName(b.b)}
                </p>
                <p className="mt-1 text-muted">{t('graph.discover.noBridge')}</p>
                <button className="mt-1.5 inline-flex items-start gap-1 text-left text-accent hover:underline" onClick={() => ask(q)}>
                  <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0" />
                  {q}
                </button>
              </div>
            )
          })}
          {gaps.lonely.map((l) => (
            <div key={l.categoryId} className="mb-2 rounded-lg bg-sunken p-2.5 text-xs">
              <p className="flex items-center gap-1.5 text-fg">
                <span className="size-2 rounded-full" style={{ background: catColor.get(l.categoryId) }} />
                {catName(l.categoryId)}
              </p>
              <p className="mt-1 text-muted">{t('graph.discover.lonely', { notes: l.notes, cross: l.cross })}</p>
            </div>
          ))}
          {gaps.isolated.length > 0 && (
            <div className="rounded-lg bg-sunken p-2.5 text-xs">
              <p className="text-fg">{t('graph.discover.isolated', { n: gaps.isolated.length })}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {gaps.isolated.map((n) => (
                  <button
                    key={n.key}
                    onClick={() => onSelect(n.key)}
                    className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-2xs text-fg hover:border-accent"
                  >
                    {n.title || t('common.untitled')}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
