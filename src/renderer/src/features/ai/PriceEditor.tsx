import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover } from 'radix-ui'
import { CircleDollarSign } from 'lucide-react'
import { resolvePrice, type ModelPrice } from '@shared/ai'
import { formatAmount } from '@shared/money'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { CurrencyPicker } from '../agent/CurrencyPicker'

// 模型价格（v0.7.5）：模型行上的小标显示输入 / 输出单价；点开可按服务商标价填写，优先于内置价格。

const num = (v: number | undefined): string => (v === undefined ? '' : String(+v.toPrecision(6)))

function Field({
  label,
  hint,
  value,
  onChange,
  symbol
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  symbol: string
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <span className="mt-1 flex h-8 items-center rounded-lg border border-border bg-surface px-2.5 focus-within:border-accent">
        <span className="text-xs text-subtle">{symbol}</span>
        <input
          inputMode="decimal"
          value={value}
          aria-label={label}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
          className="ml-1 w-full min-w-0 bg-transparent text-sm text-fg tabular-nums outline-none placeholder:text-2xs placeholder:text-subtle"
        />
      </span>
    </label>
  )
}

export function PriceChip({
  model,
  custom,
  onSave
}: {
  model: string
  custom?: ModelPrice
  onSave: (price: ModelPrice | undefined) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const resolved = resolvePrice(model, custom)
  const builtin = resolvePrice(model)
  const [open, setOpen] = useState(false)
  const base = resolved?.price ?? { currency: locale.startsWith('zh') ? 'CNY' : 'USD', input: 0, output: 0 }
  const [currency, setCurrency] = useState(base.currency)
  const [input, setInput] = useState('')
  const [cached, setCached] = useState('')
  const [output, setOutput] = useState('')
  useEffect(() => {
    if (!open) return
    setCurrency(base.currency)
    setInput(resolved ? num(base.input) : '')
    setCached(resolved ? num(base.cachedInput) : '')
    setOutput(resolved ? num(base.output) : '')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const sym = formatAmount(0, currency, locale).replace(/[\d.,\s]/g, '') || currency
  const valid = input !== '' && output !== '' && Number.isFinite(Number(input)) && Number.isFinite(Number(output))
  const save = (): void => {
    if (!valid) return
    const price: ModelPrice = {
      currency,
      input: Number(input),
      output: Number(output),
      ...(cached !== '' ? { cachedInput: Number(cached) } : {}),
      // 错峰折扣随内置价格保留（同一模型自己填价格时仍按低谷半价计）
      ...(builtin?.price.offPeak && currency === builtin.price.currency ? { offPeak: builtin.price.offPeak } : {})
    }
    onSave(price)
    setOpen(false)
  }
  const label = resolved
    ? `${formatAmount(resolved.price.input, resolved.price.currency, locale)} / ${formatAmount(resolved.price.output, resolved.price.currency, locale)}`
    : t('spend.price.unknown')
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip label={resolved ? `${t('spend.price.perM')} · ${t(`spend.price.source.${resolved.source}`)}` : t('spend.price.unknown')}>
        <Popover.Trigger asChild>
          <button
            aria-label={t('spend.price.title', { model })}
            data-testid="price-chip"
            className={cn(
              'relative inline-flex h-6 items-center gap-1 rounded-full px-2 text-2xs tabular-nums transition-colors [&_svg]:size-3',
              resolved ? 'text-subtle hover:bg-sunken hover:text-muted' : 'text-warning hover:bg-warning/10',
              resolved?.source === 'custom' && 'ring-1 ring-accent/40'
            )}
          >
            <CircleDollarSign />
            {label}
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-[60] w-72 rounded-xl border border-border bg-surface p-4 shadow-float data-[state=open]:animate-[pop-in_140ms_ease-out]"
          data-testid="price-editor"
        >
          <p className="truncate text-sm font-medium text-fg">{t('spend.price.title', { model })}</p>
          <p className="mt-0.5 text-2xs text-subtle">
            {t('spend.price.hint')} {t('spend.price.perM')}
          </p>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-muted">{t('spend.price.currency')}</span>
            <CurrencyPicker value={currency} onChange={setCurrency} label={t('spend.price.currency')} size="sm" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Field label={t('spend.price.input')} value={input} onChange={setInput} symbol={sym} />
            <Field label={t('spend.price.output')} value={output} onChange={setOutput} symbol={sym} />
            <div className="col-span-2">
              <Field label={t('spend.price.cached')} hint={t('spend.price.cachedHint')} value={cached} onChange={setCached} symbol={sym} />
            </div>
          </div>
          {resolved && <p className="mt-2 text-2xs text-subtle">{t(`spend.price.source.${resolved.source}`)}</p>}
          {builtin?.price.offPeak && <p className="mt-1 text-2xs text-subtle">{t('spend.price.offPeak')}</p>}
          <div className="mt-4 flex items-center justify-between gap-2">
            {custom ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onSave(undefined)
                  setOpen(false)
                }}
              >
                {builtin ? t('spend.price.reset') : t('spend.price.clear')}
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" variant="primary" disabled={!valid} onClick={save}>
              {t('spend.price.save')}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
