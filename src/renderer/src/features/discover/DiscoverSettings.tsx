import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { SearchService } from '@shared/discover'
import { fromUsd, toUsd } from '@shared/money'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { useMoney } from '@/lib/money'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useDiscoverEvents } from './queries'
const field = 'mt-1 w-full min-w-0 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-fg'
export function SearchSettings() {
  const { t } = useTranslation(),
    qc = useQueryClient(),
    [service, setService] = useState<SearchService>('bocha'),
    [key, setKey] = useState(''),
    [enabled, setEnabled] = useState<boolean | null>(null),
    [busy, setBusy] = useState(false)
  useDiscoverEvents()
  const { data: providers = [] } = useQuery({ queryKey: ['discover', 'search'], queryFn: () => api.discover.searchProviders() }),
    selected = providers.find((p) => p.service === service)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      void qc.invalidateQueries({ queryKey: ['discover', 'search'] })
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="border-b border-border py-5" data-testid="search-settings">
      <h3 className="text-sm font-medium">{t('discover.searchTitle')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">{t('discover.searchHelp')}</p>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
        <label className="text-xs text-muted">
          {t('discover.searchService')}
          <select
            className={field}
            aria-label={t('discover.searchService')}
            value={service}
            onChange={(e) => {
              setService(e.target.value as SearchService)
              setKey('')
              setEnabled(null)
            }}
          >
            <option value="bocha">博查 · Bocha</option>
            <option value="tavily">Tavily</option>
            <option value="brave">Brave Search</option>
          </select>
        </label>
        <label className="text-xs text-muted">
          {t('discover.searchKey')}
          <input
            type="password"
            autoComplete="new-password"
            aria-label={t('discover.searchKey')}
            className={field}
            placeholder={t(selected?.keySet ? 'discover.keySet' : 'discover.keyUnset')}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          <Switch aria-label={t('discover.searchEnable')} checked={enabled ?? selected?.enabled ?? false} onCheckedChange={setEnabled} />
          {t('discover.searchEnable')}
        </label>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.discover.searchSave({ service, ...(key ? { key } : {}), enabled: enabled ?? selected?.enabled ?? false })
              setKey('')
              setEnabled(null)
            })
          }
        >
          {t('common.save')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !selected?.keySet}
          onClick={() =>
            void run(async () => {
              const result = await api.discover.searchTest(service)
              if (result.ok) toast.success(result.message)
              else toast.error(result.message)
            })
          }
        >
          {t('discover.test')}
        </Button>
        {selected?.keySet && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => api.discover.searchSave({ service, key: '', enabled: false }))}
          >
            {t('discover.clearKey')}
          </Button>
        )}
      </div>
    </section>
  )
}
export function DiscoverSettings() {
  const { t } = useTranslation(),
    { data: settings } = useSettings(),
    update = useUpdateSettings(),
    money = useMoney()
  if (!settings) return null
  const config = settings.discover,
    amount = fromUsd(toUsd(config.dailyBudget, config.budgetCurrency, settings.money) ?? 0, money.currency, settings.money)
  return (
    <section data-testid="discover-settings" className="py-4">
      <h3 className="font-serif text-lg">{t('discover.title')}</h3>
      <p className="mt-2 text-xs leading-relaxed text-muted">{t('discover.settingsHint')}</p>
      <div className="mt-5 grid grid-cols-2 gap-4">
        <label className="text-xs text-muted">
          {t('discover.dailyLimit')}
          <input
            type="number"
            className={field}
            aria-label={t('discover.dailyLimit')}
            min={0}
            max={5}
            value={config.dailyLimit}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isInteger(v) && v >= 0 && v <= 5) update.mutate({ discover: { ...config, dailyLimit: v } })
            }}
          />
        </label>
        <label className="text-xs text-muted">
          {t('discover.dailyBudget')} · {money.currency}
          <input
            type="number"
            className={field}
            aria-label={t('discover.dailyBudget')}
            min={0}
            max={1000}
            step="0.1"
            value={Number(amount.toFixed(4))}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v >= 0 && v <= 1000)
                update.mutate({ discover: { ...config, dailyBudget: v, budgetCurrency: money.currency } })
            }}
          />
        </label>
      </div>
      <label className="mt-5 flex items-center gap-2 text-sm">
        <Switch
          aria-label={t('discover.useSearch')}
          checked={config.useSearch}
          onCheckedChange={(useSearch) => update.mutate({ discover: { ...config, useSearch } })}
        />
        {t('discover.useSearch')}
      </label>
      <label className="mt-5 flex items-center gap-2 text-sm">
        <Switch aria-label={t('discover.podcast')} checked={config.podcast} onCheckedChange={(podcast) => update.mutate({ discover: { ...config, podcast } })} />
        {t('discover.podcast')}
      </label>
      <p className="mt-2 text-xs leading-relaxed text-muted">{t('discover.podcastHint')}</p>
    </section>
  )
}
