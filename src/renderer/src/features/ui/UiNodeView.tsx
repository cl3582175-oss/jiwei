import { useExpandedPresentation } from '@/components/ui/ExpandableSurface'
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
import { ChoiceNode, FormNode } from './nodes/Input'
import { QuizNode, FlashcardsNode, ClozeNode } from './nodes/Practice'
import { CalcNode } from './nodes/Calc'
import { openCitation } from '@/features/chat/MessageItem'
import { cn } from '@/lib/utils'
import { UiTypeIcon } from './typeIcon'

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
type ViewProps = { node: UiNode; uiKey: string; ctx: UiContext; partial?: boolean }
export function UiNodeView(props: ViewProps) {
  const { runOutside } = useExpandedPresentation()
  const { node, ctx, uiKey } = props
  const refs = Array.isArray(node.cite) ? [...node.cite] : typeof node.cite === 'number' ? [node.cite] : []
  if (node.type === 'list') refs.push(...(node.items ?? []).flatMap((item) => item.cite ?? []))
  if (node.type === 'quiz' || node.type === 'flashcards') {
    const value = ctx.states[uiKey]?.[node.type === 'quiz' ? 'question' : 'card']
    const index = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
    refs.push(...(node.type === 'quiz' ? (node.items?.[index]?.cite ?? []) : (node.cards?.[index]?.cite ?? [])))
  }
  const citations = ctx.citations ?? ctx.message?.citations ?? []
  return (
    <>
      <UiContent {...props} />
      {!!refs.length && (
        <div className="flex flex-wrap gap-1 px-4 pb-3">
          {[...new Set(refs)].map((n) => {
            const citation = citations.find((c) => c.n === n)
            return citation ? (
              <button
                key={n}
                className="cite-chip"
                aria-label={`[${n}] ${citation.title}`}
                title={citation.title}
                onClick={() => runOutside(() => openCitation(citation, ctx.conversationId))}
              >
                {n}
              </button>
            ) : (
              <sup key={n} className="text-2xs text-subtle">
                [{n}]
              </sup>
            )
          })}
        </div>
      )}
    </>
  )
}
function UiContent({ node, uiKey, ctx, partial = false }: ViewProps) {
  const { t } = useTranslation()
  const disabled = partial || ctx.stopped
  const child = (n: UiNode, i: string | number) => (
    <div key={`${uiKey}.${i}`} className="min-w-0">
      {n.title && (
        <p className="flex items-center gap-2 px-4 pt-3 text-sm font-medium">
          <UiTypeIcon type={n.type} />
          {n.title}
        </p>
      )}
      <UiNodeView node={n} uiKey={`${uiKey}.${i}`} ctx={ctx} partial={partial} />
    </div>
  )
  if (partial && !['table', 'list', 'stat', 'steps', 'timeline', 'columns', 'tabs', 'choice', 'form'].includes(node.type))
    return <UiSkeleton type={node.type} value={node as unknown as Record<string, unknown>} />
  switch (node.type) {
    case 'calc':
      return <CalcNode node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} />
    case 'quiz':
      return <QuizNode node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} />
    case 'flashcards':
      return <FlashcardsNode node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} />
    case 'cloze':
      return <ClozeNode node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} />
    case 'choice':
      return <ChoiceNode node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} />
    case 'form':
      return <FormNode node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} />
    case 'schedule':
    case 'tasks':
    case 'note':
    case 'excerpt':
    case 'mastery':
    case 'decision':
    case 'usage':
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
        <div
          className="grid gap-2.5 px-4 py-3"
          style={{ gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, node.items?.length ?? 0))}, minmax(0, 1fr))` }}
        >
          {(node.items ?? []).map((item, i) => (
            // 数字卡：左侧色条按分类色区分各项，数字本身用正文色保证可读
            <div
              key={i}
              data-testid="ui-stat-item"
              className="ui-tile relative min-w-0 overflow-hidden rounded-lg py-2.5 pr-3 pl-4"
              style={{ boxShadow: `inset 3px 0 0 var(--viz-${(i % 8) + 1})` }}
            >
              <p className="truncate text-xs text-muted">{item.label}</p>
              <p className="mt-1 text-2xl leading-tight font-semibold tabular-nums">
                {item.value}
                <span className="ml-1 text-xs font-normal text-subtle">{item.unit}</span>
              </p>
              {item.delta && (
                <p
                  className={cn(
                    'mt-1 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-2xs font-medium tabular-nums',
                    item.trend === 'up'
                      ? 'bg-viz-3/12 text-viz-3'
                      : item.trend === 'down'
                        ? 'bg-viz-4/12 text-viz-4'
                        : 'bg-border/60 text-muted'
                  )}
                >
                  {item.trend === 'up' ? '↑' : item.trend === 'down' ? '↓' : '–'} {item.delta}
                </p>
              )}
              {item.note && <p className="mt-1 text-2xs text-subtle">{item.note}</p>}
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
        <ol className="ui-steps ui-plain-list px-4 py-3">
          {(node.items ?? []).map((item, i) => {
            const state = node.current === undefined ? 'todo' : i < node.current ? 'done' : i === node.current ? 'current' : 'todo'
            const head = (
              <>
                <span className="ui-step-dot" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="min-w-0 pt-0.5 text-sm">{item.title}</span>
              </>
            )
            return (
              <li key={i} className="ui-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                {item.detail ? (
                  <details>
                    <summary className="ui-step-head">{head}</summary>
                    <p className="ui-step-detail">{item.detail}</p>
                  </details>
                ) : (
                  <div className="ui-step-head">{head}</div>
                )}
              </li>
            )
          })}
        </ol>
      )
    case 'chart':
      return (
        <div>
          {/* 标题和说明已由组件框显示，图里不再重复 */}
          <ChartBox data={{ ...toChartData(node), note: undefined }} showTitle={false} />
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
        <TimelineBox data={{ ...node, title: undefined }} />
      )
    case 'codesteps':
      return <CodeStepsBox data={{ ...node, title: undefined }} />
    // 其它阶段的类型先保持数据可读，真实互动由各阶段交付。
    default:
      return (
        <div className="px-4 py-3">
          <Streamdown mode="static">{uiToText(node)}</Streamdown>
        </div>
      )
  }
}
