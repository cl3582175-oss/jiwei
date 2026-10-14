import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UiNode } from '@shared/ui/catalog'
import { matrixTotals, type Decision } from '@shared/advisor'
import type { UsageSummary } from '@shared/agent'
import { localDay } from '@shared/plan'
import { useApp } from '@/store/app'
import { useMoney } from '@/lib/money'
import { ChartBox } from '@/features/visuals/ChartBox'
import { DecideDialog } from '@/features/advisor/AdvisorView'
import { setAdvisorDraft } from '@/features/advisor/generation'
import type { UiContext } from '../context'
import { uiAction } from '../ConfirmSheet'

export function DecisionBox({
  node,
  decision,
  ctx,
  uiKey,
  disabled
}: {
  node: Extract<UiNode, { type: 'decision' }>
  decision?: Decision
  ctx: UiContext
  uiKey: string
  disabled: boolean
}) {
  const { t } = useTranslation(),
    [deciding, setDeciding] = useState(false)
  const matrix = useMemo(
    () =>
      node.decisionId
        ? decision?.memo
        : node.options && node.criteria && node.scores
          ? { options: node.options, criteria: node.criteria, scores: node.scores }
          : null,
    [node, decision]
  )
  const prior = ctx.states[uiKey]?.weights as Record<string, unknown> | undefined
  const weights = useMemo(
    () =>
      Object.fromEntries(
        (matrix?.criteria ?? []).map((c) => {
          const v = prior?.[c.name] ?? decision?.weights?.[c.name]
          return [c.name, typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 5 ? v : c.weight]
        })
      ),
    [matrix, prior, decision?.weights]
  )
  const totals = useMemo(() => (matrix ? matrixTotals(matrix, weights) : {}), [matrix, weights])
  const best = matrix?.options.reduce((a, b) => (totals[b.id] > totals[a.id] ? b : a)).id
  useEffect(() => {
    if (!node.decisionId && matrix)
      ctx.snapshot?.(
        uiKey,
        [
          node.question,
          ...matrix.criteria.map((c) => `${c.name}: ${weights[c.name]}`),
          ...matrix.options.map((o) => `${o.title}: ${totals[o.id]}`)
        ].join('\n')
      )
  }, [node, uiKey, ctx, matrix, weights, totals])
  if (!matrix) return null
  return (
    <div className="space-y-3">
      {!node.decisionId && <p className="text-2xs text-accent">{t('ui.suggestion')}</p>}
      <p className="text-sm">{decision?.question ?? node.question}</p>
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className="p-2 text-left">{t('ui.criterion')}</th>
              <th className="p-2">{t('ui.weight')}</th>
              {matrix.options.map((o) => (
                <th className="p-2" key={o.id}>
                  {o.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.criteria.map((c) => (
              <tr key={c.name} className="border-t border-border">
                <th className="p-2 text-left font-normal">{c.name}</th>
                <td className="p-2 text-center whitespace-nowrap">
                  <button
                    aria-label={t('ui.decrease', { name: c.name })}
                    className={uiAction}
                    disabled={disabled || weights[c.name] <= 1}
                    onClick={() => ctx.setState(uiKey, { weights: { ...weights, [c.name]: weights[c.name] - 1 } })}
                  >
                    −
                  </button>
                  <span className="px-2 tabular-nums">{weights[c.name]}</span>
                  <button
                    aria-label={t('ui.increase', { name: c.name })}
                    className={uiAction}
                    disabled={disabled || weights[c.name] >= 5}
                    onClick={() => ctx.setState(uiKey, { weights: { ...weights, [c.name]: weights[c.name] + 1 } })}
                  >
                    +
                  </button>
                </td>
                {matrix.options.map((o) => (
                  <td className="p-2 text-center tabular-nums" key={o.id}>
                    {matrix.scores.find((s) => s.option === o.id && s.criterion === c.name)?.score ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <td className="p-2" colSpan={2}>
                {t('ui.total')}
              </td>
              {matrix.options.map((o) => (
                <td className="p-2 text-center tabular-nums" key={o.id}>
                  {totals[o.id]}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      {node.decisionId ? (
        decision?.memo && (
          <button className={uiAction} disabled={disabled} onClick={() => setDeciding(true)}>
            {t('ui.action.decide')}
          </button>
        )
      ) : (
        <button
          className={uiAction}
          disabled={disabled}
          onClick={() => {
            setAdvisorDraft({ question: node.question! })
            useApp.getState().setView('advisor')
          }}
        >
          {t('ui.action.toAdvisor')}
        </button>
      )}
      {deciding && decision?.memo && (
        <DecideDialog d={decision} memo={decision.memo} initialPick={best} onClose={() => setDeciding(false)} />
      )}
    </div>
  )
}

export function UsageBox({ node, summary }: { node: Extract<UiNode, { type: 'usage' }>; summary: UsageSummary }) {
  const { t } = useTranslation(),
    money = useMoney()
  const days =
    node.range === 'today'
      ? summary.days.filter((d) => d.date === localDay(Date.now()))
      : summary.days.filter((d) => d.date.startsWith(localDay(Date.now()).slice(0, 7)))
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: t('ui.today'), value: summary.today },
          { label: t('ui.month'), value: summary.month }
        ].map((item) => (
          <div key={item.label}>
            <p className="text-xs text-muted">
              {item.label} · {money.currency}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{money.format(item.value)}</p>
          </div>
        ))}
      </div>
      {!!days.length && (
        <ChartBox
          data={{
            type: 'bar',
            categories: days.map((d) => d.date),
            series: [{ name: money.currency, data: days.map((d) => money.toDisplay(d.cost)) }]
          }}
        />
      )}
      <button className={uiAction} onClick={() => useApp.getState().openUsage()}>
        {t('ui.action.openUsage')}
      </button>
    </div>
  )
}
