import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { GraphEdge, GraphNode } from '@shared/types'
import { RELATION_META, familyOf, relationSentence } from '@shared/graphRelations'
import type { Tokens } from '@/features/visuals/tokens'
import { FAMILIES, edgeStyle } from './model'

/** 关系列表：同一份数据的表格视图，方便精读，也照顾读屏 */
export function RelationList({
  nodes,
  edges,
  c,
  onSelect
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  c: Tokens
  onSelect(key: string): void
}) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes])
  // 有类型的关系排在前面，同一家族放在一起
  const rows = useMemo(
    () =>
      edges
        .filter((e) => byKey.has(e.from) && byKey.has(e.to))
        .map((e) => ({ e, family: e.kind === 'source' ? 'source' : familyOf(e.relation) }))
        .sort((a, b) => {
          const order = (f: string): number => (f === 'source' ? 9 : f === 'assoc' ? 8 : FAMILIES.indexOf(f as never))
          return order(a.family) - order(b.family)
        }),
    [edges, byKey]
  )
  if (!rows.length) return <p className="absolute inset-0 grid place-items-center text-sm text-muted">{t('graph.list.empty')}</p>
  return (
    <div className="absolute inset-0 overflow-auto px-8 pt-20 pb-8" data-testid="graph-list">
      <table className="w-full max-w-5xl border-collapse text-sm">
        <thead className="sticky top-0 bg-[var(--panel)] text-left text-xs text-muted">
          <tr>
            <th className="border-b border-border-strong px-3 py-2 font-medium">{t('graph.list.sentence')}</th>
            <th className="w-36 border-b border-border-strong px-3 py-2 font-medium">{t('graph.list.relation')}</th>
            <th className="w-28 border-b border-border-strong px-3 py-2 font-medium">{t('graph.list.origin')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ e }) => {
            const a = byKey.get(e.from)!.title || t('common.untitled'),
              b = byKey.get(e.to)!.title || t('common.untitled')
            const style = edgeStyle(e, c)
            return (
              <tr key={`${e.from}|${e.to}`} className="cursor-pointer hover:bg-surface-hover" onClick={() => onSelect(e.from)}>
                <td className="border-b border-border/60 px-3 py-2 text-fg">
                  {e.kind === 'source' || e.relation === 'related' ? `${a} — ${b}` : relationSentence(e.relation, a, b, zh)}
                </td>
                <td className="border-b border-border/60 px-3 py-2">
                  <span className="inline-flex items-center gap-2 text-xs text-muted">
                    <span className="h-[3px] w-4 rounded-full" style={{ background: style.color }} />
                    {e.kind === 'source' ? t('graph.legend.source') : zh ? RELATION_META[e.relation].zh : RELATION_META[e.relation].en}
                  </span>
                </td>
                <td className="border-b border-border/60 px-3 py-2 text-xs text-subtle">
                  {e.kind === 'reference' ? t('graph.textLink') : e.status === 'suggested' ? t('graph.suggested') : t('graph.manual')}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
