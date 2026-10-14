import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { UiNode } from '@shared/ui/catalog'
import type { UiContext } from '../context'
import { cn } from '@/lib/utils'

export function Columns({ children, compact, ratio }: { children: ReactNode; compact: boolean; ratio?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(compact)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([entry]) => setNarrow(compact || entry.contentRect.width < 480))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [compact])
  const tracks =
    ratio === '1:1:1'
      ? 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)'
      : ratio === '382:618'
        ? 'minmax(0,382fr) minmax(0,618fr)'
        : ratio === '618:382'
          ? 'minmax(0,618fr) minmax(0,382fr)'
          : 'repeat(2,minmax(0,1fr))'
  return (
    <div
      ref={ref}
      data-testid="ui-columns"
      data-layout={narrow ? 'stack' : 'columns'}
      className="grid min-w-0 gap-3 p-3"
      style={{ gridTemplateColumns: narrow ? 'minmax(0,1fr)' : tracks }}
    >
      {children}
    </div>
  )
}
export function Tabs({
  node,
  children,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'tabs' }>
  children(index: number): ReactNode
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const tabs = node.tabs ?? []
  const index = Math.min(Number(ctx.states[uiKey]?.tab ?? 0), Math.max(0, tabs.length - 1))
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  return (
    <div className="p-3">
      <div role="tablist" className="mb-3 flex gap-1 border-b border-border">
        {tabs.map((tab, i) => (
          <button
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            role="tab"
            aria-selected={index === i}
            aria-controls={`${uiKey}-panel-${i}`}
            tabIndex={index === i ? 0 : -1}
            disabled={disabled}
            className={cn('rounded-t px-3 py-2 text-xs', index === i && 'bg-sunken text-accent')}
            onClick={() => ctx.setState(uiKey, { tab: i })}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                ctx.setState(uiKey, { tab: next })
                refs.current[next]?.focus()
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uiKey}-panel-${index}`}>
        {children(index)}
      </div>
    </div>
  )
}
export function TableNode({
  node,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'table' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const { t } = useTranslation()
  const state = ctx.states[uiKey] ?? {}
  const sort = state.sort as { key: string; direction: number } | undefined
  const cols = node.columns ?? [],
    shown = ctx.compact ? cols.slice(0, 4) : cols
  const rows = (node.rows ?? []).map((row, index) => ({ row, index }))
  if (sort?.direction)
    rows.sort((a, b) => {
      const l = a.row[sort.key],
        r = b.row[sort.key]
      return (typeof l === 'number' && typeof r === 'number' ? l - r : String(l ?? '').localeCompare(String(r ?? ''))) * sort.direction
    })
  return (
    <div className="max-h-[400px] overflow-auto px-3 py-2">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr>
            {shown.map((col) => (
              <th
                key={col.key}
                className="border-b border-border px-2 py-2 text-left font-medium"
                aria-sort={
                  sort?.key === col.key ? (sort.direction === 1 ? 'ascending' : sort.direction === -1 ? 'descending' : 'none') : 'none'
                }
              >
                <button
                  disabled={disabled}
                  className="w-full text-left disabled:cursor-default"
                  onClick={() =>
                    ctx.setState(uiKey, {
                      sort: {
                        key: col.key,
                        direction: sort?.key === col.key ? (sort.direction === 1 ? -1 : sort.direction === -1 ? 0 : 1) : 1
                      }
                    })
                  }
                >
                  {col.label}
                  {sort?.key === col.key && sort.direction !== 0 && <span aria-hidden="true"> {sort.direction === 1 ? '↑' : '↓'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, index }) => (
            <tr key={index}>
              {shown.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    'border-b border-border/50 px-2 py-2',
                    (col.align === 'right' || col.kind === 'number') && 'text-right tabular-nums',
                    node.highlight?.some((h) => (h.row === undefined || h.row === index) && (h.col === undefined || h.col === col.key)) &&
                      'bg-accent/10'
                  )}
                >
                  {row[col.key] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {ctx.compact && cols.length > 4 && (
        <details className="pt-2 text-2xs text-muted">
          <summary>{t('ui.details')}</summary>
          {rows.map(({ row, index }) => (
            <p key={index}>
              {cols
                .slice(4)
                .map((c) => `${c.label}: ${row[c.key] ?? ''}`)
                .join(' · ')}
            </p>
          ))}
        </details>
      )}
    </div>
  )
}
export function ListNode({
  node,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'list' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const checked = ctx.states[uiKey]?.checked as Record<string, boolean> | undefined
  const Tag = node.ordered ? 'ol' : 'ul'
  return (
    <Tag className="space-y-2 px-4 py-3 text-sm">
      {(node.items ?? []).map((item, i) => (
        <li key={i} className="flex items-start gap-2">
          {node.checkable ? (
            <input
              aria-label={item.text}
              type="checkbox"
              checked={checked?.[i] ?? item.done ?? false}
              disabled={disabled}
              onChange={(e) => ctx.setState(uiKey, { checked: { ...checked, [i]: e.target.checked } })}
              className="mt-1 accent-accent"
            />
          ) : (
            <span className="text-subtle">{node.ordered ? `${i + 1}.` : '•'}</span>
          )}
          <div className="min-w-0">
            <span>{item.text}</span>
            {item.note && <p className="mt-1 text-xs text-muted">{item.note}</p>}
          </div>
        </li>
      ))}
    </Tag>
  )
}
