import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover } from 'radix-ui'
import { Check, ChevronDown, Search } from 'lucide-react'
import { allCurrencies, COMMON_CURRENCIES, currencyName, currencySymbol } from '@shared/money'
import { cn } from '@/lib/utils'

/** 币种选择：常用币种在前，其余全部 ISO 4217 币种可按名称或代码搜索 */
export function CurrencyPicker({
  value,
  onChange,
  label,
  size = 'md',
  testId
}: {
  value: string
  onChange: (code: string) => void
  label: string
  size?: 'sm' | 'md'
  testId?: string
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const locale = i18n.language
  const all = useMemo(() => {
    const common = new Set<string>(COMMON_CURRENCIES)
    return allCurrencies()
      .filter((c) => !common.has(c))
      .map((code) => ({ code, name: currencyName(code, locale) }))
      .sort((a, b) => a.name.localeCompare(b.name, locale))
  }, [locale])
  const common = useMemo(() => COMMON_CURRENCIES.map((code) => ({ code, name: currencyName(code, locale) })), [locale])
  const query = q.trim().toLowerCase()
  const match = (c: { code: string; name: string }): boolean =>
    !query || c.code.toLowerCase().includes(query) || c.name.toLowerCase().includes(query)
  const pick = (code: string): void => {
    onChange(code)
    setOpen(false)
    setQ('')
  }
  const Row = ({ c }: { c: { code: string; name: string } }) => (
    <button
      role="option"
      aria-selected={c.code === value}
      onClick={() => pick(c.code)}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-surface-hover',
        c.code === value ? 'text-accent' : 'text-fg'
      )}
    >
      <span className="w-9 shrink-0 text-xs text-subtle tabular-nums">{currencySymbol(c.code, locale)}</span>
      <span className="min-w-0 flex-1 truncate">{c.name}</span>
      <span className="font-mono text-2xs text-subtle">{c.code}</span>
      {c.code === value ? <Check className="size-3.5" /> : <span className="w-3.5" />}
    </button>
  )
  const commonHits = common.filter(match)
  const allHits = all.filter(match)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          aria-label={label}
          data-testid={testId}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg border border-border bg-surface text-fg transition-colors hover:border-border-strong focus-visible:border-accent focus-visible:outline-none',
            size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm'
          )}
        >
          <span className="text-subtle">{currencySymbol(value, locale)}</span>
          <span>{size === 'sm' ? value : `${currencyName(value, locale)} · ${value}`}</span>
          <ChevronDown className="size-3.5 text-subtle" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-[70] w-72 rounded-xl border border-border bg-surface p-1.5 shadow-float data-[state=open]:animate-[pop-in_140ms_ease-out]"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).querySelector('input')?.focus()
          }}
        >
          <label className="mb-1 flex h-8 items-center gap-2 rounded-md bg-sunken px-2">
            <Search className="size-3.5 text-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('spend.currency.search')}
              aria-label={t('spend.currency.search')}
              className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
            />
          </label>
          <div role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
            {commonHits.length > 0 && <p className="px-2 pt-1.5 pb-1 text-2xs text-subtle">{t('spend.currency.common')}</p>}
            {commonHits.map((c) => (
              <Row key={c.code} c={c} />
            ))}
            {allHits.length > 0 && <p className="px-2 pt-2 pb-1 text-2xs text-subtle">{t('spend.currency.all')}</p>}
            {allHits.map((c) => (
              <Row key={c.code} c={c} />
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
