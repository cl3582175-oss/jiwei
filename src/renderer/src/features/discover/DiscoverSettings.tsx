import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { DEFAULT_PODCAST_VOICE, LOCAL_VOICES, TTS_MODELS, TTS_VOICES, type PodcastVoice, type SearchService } from '@shared/discover'
import { estimateCost } from '@shared/ai'
import { Cloud, Cpu, Download, HardDrive, Loader2, Play, Volume2 } from 'lucide-react'
import { Segmented } from '@/features/plan/ui'
import { fromUsd, toUsd } from '@shared/money'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { useMoney } from '@/lib/money'
import { api, cn, formatBytes } from '@/lib/utils'
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
        <Switch
          aria-label={t('discover.podcast')}
          checked={config.podcast}
          onCheckedChange={(podcast) => update.mutate({ discover: { ...config, podcast } })}
        />
        {t('discover.podcast')}
      </label>
      <p className="mt-2 text-xs leading-relaxed text-muted">{t('discover.podcastHint')}</p>
      {config.podcast && <PodcastVoiceSettings />}
    </section>
  )
}

/** 播客的朗读方式：系统语音（免费）、本机 AI 语音（免费，需下载模型）、云端 AI 语音（按字数计费） */
function PodcastVoiceSettings() {
  const { t, i18n } = useTranslation(),
    qc = useQueryClient(),
    { data: settings } = useSettings(),
    update = useUpdateSettings(),
    money = useMoney()
  const { data: providers = [] } = useQuery({ queryKey: ['discover', 'tts'], queryFn: () => api.discover.ttsProviders() })
  const { data: speech } = useQuery({ queryKey: ['discover', 'speech'], queryFn: () => api.discover.speechStatus() })
  const [previewing, setPreviewing] = useState<string | null>(null)
  const player = useRef<HTMLAudioElement | null>(null)
  useEffect(() => window.jiweiEvents.on('speech:status', (s) => qc.setQueryData(['discover', 'speech'], s)), [qc])
  useEffect(() => () => player.current?.pause(), [])
  if (!settings) return null
  const config = settings.discover,
    voice = config.podcastVoice ?? DEFAULT_PODCAST_VOICE,
    zh = i18n.language.startsWith('zh'),
    local = voice.engine === 'local',
    provider = providers.find((p) => p.providerId === voice.providerId) ?? providers[0],
    voices = local ? LOCAL_VOICES : provider ? TTS_VOICES[provider.engine] : [],
    voiceA = voices.find((v) => v.id === voice.voiceA)?.id ?? voices[0]?.id ?? '',
    voiceB = voices.find((v) => v.id === voice.voiceB && v.id !== voiceA)?.id ?? voices.find((v) => v.id !== voiceA)?.id ?? '',
    ready = speech?.state === 'ready'
  const save = (next: PodcastVoice): void => update.mutate({ discover: { ...config, podcastVoice: next } })
  const set = (patch: Partial<PodcastVoice>): void =>
    save({ ...voice, providerId: local ? voice.providerId : (provider?.providerId ?? null), voiceA, voiceB, ...patch })
  // 一期约 1500 汉字（计 3000 字符）或 900 英文词（约 5000 字符）
  const cost = provider
    ? estimateCost(
        TTS_MODELS[provider.engine],
        { inputTokens: zh ? 3000 : 5000, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
        Date.now(),
        null,
        settings.money
      )
    : null
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  const preview = (id: string): Promise<void> =>
    run(async () => {
      setPreviewing(id)
      try {
        const url = await api.discover.voicePreview(local ? 'local' : 'ai', id, provider?.providerId ?? null)
        player.current?.pause()
        player.current = new Audio(url)
        await player.current.play()
      } finally {
        setPreviewing(null)
      }
    })
  const engines = [
    {
      id: 'system' as const,
      icon: <Volume2 className="size-3.5" />,
      title: t('discover.voiceSystem'),
      hint: t('discover.voiceSystemHint')
    },
    {
      id: 'local' as const,
      icon: <Cpu className="size-3.5 text-accent" />,
      title: t('discover.voiceLocal'),
      hint: t('discover.voiceLocalHint')
    },
    { id: 'ai' as const, icon: <Cloud className="size-3.5 text-accent" />, title: t('discover.voiceAi'), hint: t('discover.voiceAiHint') }
  ]
  const voicePicker = (label: string, value: string, onChange: (v: string) => void, exclude?: string) => (
    <label className="text-xs text-muted">
      {label}
      <div className="mt-1 flex gap-1.5">
        <select className={cn(field, 'mt-0')} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          {voices
            .filter((v) => v.id !== exclude)
            .map((v) => (
              <option key={v.id} value={v.id}>
                {zh ? v.zh : v.en}
              </option>
            ))}
        </select>
        <Button
          size="icon"
          variant="outline"
          className="shrink-0"
          aria-label={t('discover.voicePreview', { name: label })}
          title={t('discover.voicePreviewHint')}
          disabled={!!previewing || !value}
          onClick={() => void preview(value)}
        >
          {previewing === value ? <Loader2 className="animate-spin" /> : <Play />}
        </Button>
      </div>
    </label>
  )
  const voiceRows = (
    <>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="col-span-2 text-xs text-muted">
          {t('discover.voiceStyle')}
          <div className="mt-1">
            <Segmented
              label={t('discover.voiceStyle')}
              value={voice.style}
              onChange={(style) => set({ style })}
              options={[
                { value: 'solo', label: t('discover.voiceSolo') },
                { value: 'dialogue', label: t('discover.voiceDialogue') }
              ]}
            />
          </div>
        </div>
        {voicePicker(voice.style === 'dialogue' ? t('discover.voiceA') : t('discover.voiceOne'), voiceA, (v) => set({ voiceA: v }))}
        {voice.style === 'dialogue' && voicePicker(t('discover.voiceB'), voiceB, (v) => set({ voiceB: v }), voiceA)}
      </div>
      <p className="mt-3 text-2xs text-subtle">{t('discover.voiceRegenerate')}</p>
    </>
  )
  return (
    <div className="mt-4 rounded-xl border border-border bg-sunken/40 p-4" data-testid="podcast-voice-settings">
      <p className="text-xs font-medium text-fg">{t('discover.voiceEngine')}</p>
      <div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('discover.voiceEngine')}>
        {engines.map((e) => (
          <button
            key={e.id}
            type="button"
            role="radio"
            aria-checked={voice.engine === e.id}
            onClick={() => set({ engine: e.id, ...(e.id !== voice.engine ? { voiceA: null, voiceB: null } : {}) })}
            className={cn(
              'rounded-lg border p-3 text-left transition-[background-color,border-color,box-shadow]',
              voice.engine === e.id ? 'border-accent bg-surface shadow-[var(--shadow-1)]' : 'border-border hover:bg-surface-hover'
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
              {e.icon}
              {e.title}
              {e.id === 'local' && (
                <span className="rounded-full bg-accent-soft px-1.5 text-[10px] text-accent">{t('discover.recommended')}</span>
              )}
            </span>
            <span className="mt-1 block text-2xs leading-relaxed text-muted">{e.hint}</span>
          </button>
        ))}
      </div>

      {local && !ready && (
        <div className="mt-3 rounded-lg border border-border bg-surface p-3" data-testid="speech-model">
          {speech?.state === 'downloading' ? (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-fg">{t('discover.speechDownloading', { percent: Math.round((speech.progress ?? 0) * 100) })}</span>
                <Button size="sm" variant="ghost" onClick={() => void run(() => api.discover.speechCancel())}>
                  {t('common.cancel')}
                </Button>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300"
                  style={{ width: `${(speech.progress ?? 0) * 100}%` }}
                />
              </div>
              {speech.speed ? <p className="mt-1.5 text-2xs text-subtle tabular-nums">{formatBytes(speech.speed)}/s</p> : null}
            </>
          ) : (
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
                {speech?.state === 'error' ? (
                  <span className="text-danger">{speech.message}</span>
                ) : (
                  t('discover.speechMissing', { size: formatBytes(speech?.bytes ?? 0) })
                )}
              </p>
              <Button size="sm" variant="primary" onClick={() => void run(() => api.discover.speechInstall())}>
                <Download />
                {t(speech?.state === 'error' ? 'discover.speechRetry' : 'discover.speechDownload')}
              </Button>
            </div>
          )}
        </div>
      )}
      {local && ready && voiceRows}

      {voice.engine === 'ai' &&
        (providers.length === 0 ? (
          <p className="mt-3 text-xs text-warning">{t('discover.voiceNoProvider')}</p>
        ) : (
          <>
            <label className="mt-3 block text-xs text-muted">
              {t('discover.voiceProvider')}
              <select
                className={field}
                aria-label={t('discover.voiceProvider')}
                value={provider?.providerId}
                onChange={(e) => save({ ...voice, providerId: e.target.value, voiceA: null, voiceB: null })}
              >
                {providers.map((p) => (
                  <option key={p.providerId} value={p.providerId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {cost !== null && <p className="mt-2 text-2xs text-muted">{t('discover.voiceCost', { cost: money.format(cost) })}</p>}
            {voiceRows}
          </>
        ))}

      {ready && (
        <div className="mt-3 flex items-center gap-2 border-t border-border/70 pt-3 text-2xs text-subtle">
          <HardDrive className="size-3.5" />
          <span className="flex-1">{t('discover.speechUsed', { size: formatBytes(speech?.bytes ?? 0) })}</span>
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => void run(() => api.discover.speechRemove())}>
            {t('discover.speechRemove')}
          </Button>
        </div>
      )}
    </div>
  )
}
