import { useTranslation } from 'react-i18next'
import { Streamdown } from 'streamdown'
import { toChartData, uiToText, type UiNode } from '@shared/ui/catalog'
import { ChartBox } from '@/features/visuals/ChartBox'
import { DiagramBox } from '@/features/visuals/DiagramBox'
import { TimelineBox } from '@/features/visuals/TimelineBox'
import { CodeStepsBox } from '@/features/visuals/CodeStepsBox'
import type { UiContext } from './context'
import { Columns, Tabs, TableNode, ListNode } from './nodes/Basic'
import { DataNodeView } from './nodes/Data'

export function estimateHeight(type?: string, value: Record<string, unknown> = {}): number {
  const count = (key: string, min = 0) => Math.max(min, Array.isArray(value[key]) ? value[key].length : 0)
  switch (type) {
    case 'table':
      return 44 + 36 * count('rows', 3)
    case 'chart':
      return 260
    case 'diagram':
      return 220
    case 'calc':
      return 56 * (count('inputs') + count('outputs')) + 40
    case 'list':
      return 32 * count('items', 3)
    default:
      return 120
  }
}
export function UiSkeleton({ type, value }: { type?: string; value?: Record<string, unknown> }) {
  const { t } = useTranslation()
  return (
    <div role="status" className="space-y-3 p-4 text-2xs text-subtle" style={{ minHeight: estimateHeight(type, value) }}>
      <p>{t('ui.generating')}</p>
      <div className="h-3 w-3/4 animate-pulse rounded bg-sunken" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-sunken" />
    </div>
  )
}
export function UiNodeView({ node, uiKey, ctx, partial = false }: { node: UiNode; uiKey: string; ctx: UiContext; partial?: boolean }) {
  const { t } = useTranslation()
  const disabled = partial || ctx.stopped
  const child = (n: UiNode, i: string | number) => (
    <div key={`${uiKey}.${i}`} className="min-w-0">
      {n.title && <p className="px-4 pt-3 text-sm font-medium">{n.title}</p>}
      <UiNodeView node={n} uiKey={`${uiKey}.${i}`} ctx={ctx} partial={partial} />
    </div>
  )
  if (partial && !['table', 'list', 'stat', 'steps', 'timeline', 'columns', 'tabs'].includes(node.type))
    return <UiSkeleton type={node.type} value={node as unknown as Record<string, unknown>} />
  switch (node.type) {
    case 'schedule':
    case 'tasks':
    case 'note':
    case 'excerpt':
    case 'mastery':
      return <DataNodeView node={node} uiKey={uiKey} ctx={ctx} />
    case 'columns':
      return (
        <Columns compact={ctx.compact} ratio={node.ratio}>
          {(node.children ?? []).map((n, i) => child(n, i))}
        </Columns>
      )
    case 'tabs':
      return (
        <Tabs node={node} uiKey={uiKey} ctx={ctx} disabled={disabled}>
          {(i) => (node.tabs?.[i]?.children ?? []).map((n, k) => child(n, `${i}.${k}`))}
        </Tabs>
      )
    case 'details':
      return (
        <details className="px-4 py-3" open={node.open}>
          <summary className="text-sm">{node.summary}</summary>
          {node.children.map((n, i) => child(n, i))}
        </details>
      )
    case 'stat':
      return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-3 px-4 py-3">
          {(node.items ?? []).map((item, i) => (
            <div key={i}>
              <p className="text-xs text-muted">{item.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {item.value}
                <span className="ml-1 text-xs text-subtle">{item.unit}</span>
              </p>
              {item.delta && (
                <p className="text-xs text-muted">
                  {item.trend === 'up' ? '↑' : item.trend === 'down' ? '↓' : '–'} {item.delta}
                </p>
              )}
              {item.note && <p className="text-2xs text-subtle">{item.note}</p>}
            </div>
          ))}
        </div>
      )
    case 'table':
      return <TableNode node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} />
    case 'list':
      return <ListNode node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} />
    case 'steps':
      return (
        <ol className="space-y-3 px-4 py-3">
          {(node.items ?? []).map((item, i) => (
            <li key={i} className={node.current === i ? 'text-accent' : 'text-fg'}>
              <details>
                <summary className="text-sm">
                  {i + 1}. {item.title}
                </summary>
                {item.detail && <p className="mt-1 text-xs leading-relaxed text-muted">{item.detail}</p>}
              </details>
            </li>
          ))}
        </ol>
      )
    case 'chart':
      return (
        <div>
          <ChartBox data={toChartData(node)} />
          <details className="px-4 pb-3 text-xs text-muted">
            <summary>{t('ui.dataTable')}</summary>
            <Streamdown mode="static">
              {uiToText({
                type: 'table',
                columns: [{ key: 'label', label: '' }, ...node.series.map((s, i) => ({ key: `s${i}`, label: s.name }))],
                rows: (node.categories ?? node.series[0].data.map((_d, i) => String(i + 1))).map((label, i) =>
                  Object.fromEntries([
                    ['label', label],
                    ...node.series.map((s, k) => [`s${k}`, Array.isArray(s.data[i]) ? s.data[i].join(', ') : s.data[i]])
                  ])
                )
              })}
            </Streamdown>
          </details>
        </div>
      )
    case 'diagram':
      return <DiagramBox data={{ code: node.code, title: node.diagramTitle ?? node.title }} />
    case 'timeline':
      return partial ? (
        <ol className="space-y-2 px-4 py-3 text-sm">
          {(node.events ?? []).map((e, i) => (
            <li key={i}>
              {e.date} · {e.title}
            </li>
          ))}
        </ol>
      ) : (
        <TimelineBox data={node} />
      )
    case 'codesteps':
      return <CodeStepsBox data={node} />
    // 其它阶段的类型先保持数据可读，真实互动由各阶段交付。
    default:
      return (
        <div className="px-4 py-3">
          <Streamdown mode="static">{uiToText(node)}</Streamdown>
        </div>
      )
  }
}
