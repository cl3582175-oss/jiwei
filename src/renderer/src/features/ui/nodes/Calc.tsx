import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { UiNode } from '@shared/ui/catalog'
import { compileExpr } from '@shared/ui/expr'
import type { UiContext } from '../context'
import { uiAction } from '../ConfirmSheet'
import { canReply, sendUiReply } from '../reply'

export function CalcNode({
  node,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'calc' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const { t, i18n } = useTranslation()
  const saved = ctx.states[uiKey]?.inputs as Record<string, unknown> | undefined
  const values = Object.fromEntries(
    node.inputs.map((input) => {
      const v = saved?.[input.key]
      return [input.key, typeof v === 'number' && Number.isFinite(v) && v >= input.min && v <= input.max ? v : input.value]
    })
  )
  const compiled = useMemo(
    () =>
      node.outputs.map((output) =>
        compileExpr(
          output.expr,
          node.inputs.map((input) => input.key)
        )
      ),
    [node]
  )
  const frame = useRef(0),
    pending = useRef<Record<string, number> | null>(null)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const update = (key: string, value: number): void => {
    const input = node.inputs.find((i) => i.key === key)!
    if (!Number.isFinite(value)) return
    pending.current = { ...(frame.current ? pending.current : values), [key]: Math.max(input.min, Math.min(input.max, value)) }
    if (frame.current) return
    // 拖动事件合并到一帧，持久化仍走消息上下文的 300ms 防抖。
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      ctx.setState(uiKey, { inputs: pending.current })
    })
  }
  const format = (value: number, pattern = '0.00'): string =>
    new Intl.NumberFormat(i18n.language, {
      style: pattern.includes('%') ? 'percent' : 'decimal',
      useGrouping: pattern === '0,0',
      minimumFractionDigits: pattern === '0.00' ? 2 : pattern.startsWith('0.0') ? 1 : 0,
      maximumFractionDigits: pattern === '0.00' ? 2 : pattern.startsWith('0.0') ? 1 : 0
    }).format(value)
  const changed = node.inputs.some((input) => values[input.key] !== input.value)
  return (
    <div className="space-y-4 px-4 py-3">
      {node.inputs.map((input) => (
        <label key={input.key} className="block text-xs">
          <span className="mb-1 flex justify-between gap-2 text-muted">
            <span>{input.label}</span>
            <span className="tabular-nums">
              {values[input.key]} {input.unit}
            </span>
          </span>
          <input
            type={input.kind === 'slider' ? 'range' : 'number'}
            aria-label={input.label}
            min={input.min}
            max={input.max}
            step={input.step}
            disabled={disabled}
            className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm accent-accent"
            value={values[input.key]}
            onChange={(e) => update(input.key, e.target.valueAsNumber)}
          />
        </label>
      ))}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-3 border-t border-border pt-3">
        {node.outputs.map((output, i) => {
          const expr = compiled[i],
            value = expr.ok ? expr.run(values) : NaN
          return (
            <div key={i}>
              <p className="text-xs text-muted">{output.label}</p>
              <output data-testid="ui-calc-output" aria-label={output.label} className="mt-1 block text-xl font-semibold tabular-nums">
                {Number.isFinite(value) ? format(value, output.format) : t('ui.formulaError')}
              </output>
              {output.unit && <span className="text-xs text-subtle">{output.unit}</span>}
            </div>
          )
        })}
      </div>
      {changed && ctx.context === 'chat' && (
        <button
          className={uiAction}
          disabled={disabled || !canReply(ctx)}
          title={!ctx.isLatest ? t('ui.latestOnly') : undefined}
          onClick={() => {
            try {
              sendUiReply(ctx, node, uiKey, 'edit', t('ui.event.edit'), { inputs: values })
            } catch (e) {
              toast.error(String(e))
            }
          }}
        >
          {t('ui.action.applyEdit')}
        </button>
      )}
    </div>
  )
}
