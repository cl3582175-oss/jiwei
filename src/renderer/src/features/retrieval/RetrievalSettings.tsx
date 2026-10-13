import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ExternalLink, Globe } from 'lucide-react'
import { toast } from 'sonner'
import {
  BACKEND_INFO,
  WEB_BACKENDS,
  type BackendId,
  type BackendSave,
  type BackendState,
  type RetrievalSettings as RetrievalConfig,
  type WebBackendId
} from '@shared/retrieval'
import type { ProviderInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Input } from '@/components/ui/primitives'
import { Switch } from '@/components/ui/switch'
import { keys, useProviders, useSettings } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Segmented } from '@/features/plan/ui'
import { normalizeSearxngAddress, normalizeSiteLines } from './form'
import { retrievalKeys, useRetrievalStatus } from './queries'

function Section({ title, help, children, helpBelow = false }: { title: string; help: string; children: ReactNode; helpBelow?: boolean }) {
  return (
    <section className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-fg">{title}</h4>
        {!helpBelow && <p className="mt-1 text-xs leading-relaxed text-muted">{help}</p>}
      </div>
      {children}
      {helpBelow && <p className="text-xs leading-relaxed text-muted">{help}</p>}
    </section>
  )
}

function BackendCard({
  id,
  state,
  providers,
  disabled,
  optional = false
}: {
  id: BackendId
  state?: BackendState
  providers: ProviderInfo[]
  disabled: boolean
  optional?: boolean
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const info = BACKEND_INFO[id]
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [providerId, setProviderId] = useState<string | null>(state?.keyProviderId ?? null)
  const [baseUrl, setBaseUrl] = useState(state?.baseUrl ?? '')
  const [urlInvalid, setUrlInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const lock = useRef(false)
  useEffect(() => setProviderId(state?.keyProviderId ?? null), [state?.keyProviderId])
  useEffect(() => setBaseUrl(state?.baseUrl ?? ''), [state?.baseUrl])
  const ready = !!state && (!state.needsKey || state.keySet) && (id !== 'searxng' || !!state.baseUrl)
  const language = info.langs.includes('*') ? 'any' : info.langs.includes('zh') && info.langs.includes('en') ? 'both' : info.langs[0]
  const status = !ready
    ? t('retrieval.state.unconfigured')
    : state?.pausedUntil && state.pausedUntil > Date.now()
      ? t('retrieval.state.paused', {
          time: new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit', hour12: false }).format(state.pausedUntil)
        })
      : t(state?.enabled ? 'retrieval.state.enabled' : 'retrieval.state.disabled')
  const zhipuProviders = providers.filter((provider) => provider.kind === 'zhipu')
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      await fn()
    } catch {
      // IPC 的错误也只显示固定文案，不让凭证或外部响应意外进入界面。
      toast.error(t('retrieval.saveFailed'))
    } finally {
      setBusy(false)
      lock.current = false
    }
  }
  const persist = async (input: BackendSave, clearInput = false): Promise<void> => {
    await api.retrieval.saveBackend(input)
    if (clearInput) setKey('')
    setResult(null)
    void qc.invalidateQueries({ queryKey: retrievalKeys.status })
  }
  const save = (): void => {
    let url: string | null = null
    if (id === 'searxng') {
      url = normalizeSearxngAddress(baseUrl)
      setUrlInvalid(!url)
      if (!url) return
    }
    // 空输入表示保留已存凭证，清除操作才发送空串；不会读取或回显任何 Key。
    const input: BackendSave = { id, enabled: state?.enabled ?? false }
    if (id === 'searxng') input.baseUrl = url!
    else if (id === 'zhipu') {
      input.keyProviderId = providerId
      if (!providerId && key.trim()) input.key = key.trim()
      if (!providerId && state?.keyProviderId && !key.trim()) input.enabled = false
    } else if (key.trim()) input.key = key.trim()
    void act(() => persist(input, true))
  }
  const clearKey = (): void => {
    const input: BackendSave = { id, key: '', enabled: optional ? (state?.enabled ?? true) : false }
    if (id === 'zhipu') input.keyProviderId = null
    void act(async () => {
      await persist(input, true)
      if (id === 'zhipu') setProviderId(null)
    })
  }
  const test = (): void => {
    void act(async () => {
      setResult(null)
      try {
        setResult(await api.retrieval.testBackend(id))
        void qc.invalidateQueries({ queryKey: retrievalKeys.status })
      } catch {
        setResult({ ok: false, message: t('retrieval.testFailed') })
      }
    })
  }
  return (
    <div className="min-w-0 rounded-xl border border-border" data-testid={`backend-${id}`}>
      <div className="flex items-center gap-3 px-3 py-3">
        <button
          type="button"
          aria-label={info.name}
          aria-expanded={open}
          aria-controls={`retrieval-backend-${id}`}
          data-testid={`backend-${id}-expand`}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ChevronDown className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-180')} />
          <span className="truncate text-sm font-medium" title={info.name}>
            {info.name}
          </span>
          <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-2xs text-muted">{t(`retrieval.langs.${language}`)}</span>
          <span className="min-w-0 truncate text-2xs text-subtle" title={status}>
            {status}
          </span>
        </button>
        {!optional && (
          <span title={!ready ? t(id === 'searxng' ? 'retrieval.needUrlFirst' : 'retrieval.needKeyFirst') : status}>
            <Switch
              checked={state?.enabled ?? false}
              disabled={disabled || busy || !ready}
              aria-label={info.name}
              data-testid={`backend-${id}-toggle`}
              onCheckedChange={(enabled) => void act(() => persist({ id, enabled }))}
            />
          </span>
        )}
      </div>
      {open && (
        <div id={`retrieval-backend-${id}`} className="space-y-3 border-t border-border px-3 py-4">
          {id === 'zhipu' && (
            <div className="space-y-2 text-xs" role="radiogroup" aria-label={info.name + ' ' + t('retrieval.key')}>
              {zhipuProviders.map((provider) => (
                <label key={provider.id} className="flex items-start gap-2 break-words">
                  <input
                    type="radio"
                    name={`key-source-${id}`}
                    value={provider.id}
                    checked={providerId === provider.id}
                    disabled={disabled || busy}
                    onChange={() => {
                      setProviderId(provider.id)
                      setKey('')
                    }}
                    className="mt-0.5 accent-accent"
                  />
                  {t('retrieval.zhipuUseProvider', { name: provider.name })}
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`key-source-${id}`}
                  value="own"
                  checked={!providerId}
                  disabled={disabled || busy}
                  onChange={() => setProviderId(null)}
                  className="accent-accent"
                />
                {t('retrieval.zhipuOwnKey')}
              </label>
            </div>
          )}
          {id === 'searxng' ? (
            <label className="block space-y-2">
              <span className="text-xs text-muted">{t('retrieval.searxngUrl')}</span>
              <Input
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value)
                  setUrlInvalid(false)
                }}
                onBlur={() => setUrlInvalid(!!baseUrl.trim() && !normalizeSearxngAddress(baseUrl))}
                aria-label={t('retrieval.searxngUrl')}
                aria-invalid={urlInvalid}
                aria-describedby={urlInvalid ? 'searxng-error' : undefined}
                disabled={disabled || busy}
                maxLength={500}
                placeholder="https://…"
                data-testid="backend-searxng-url"
              />
              <p className="text-xs leading-relaxed text-muted">{t('retrieval.searxngHelp')}</p>
              {urlInvalid && (
                <p id="searxng-error" role="alert" className="text-xs text-danger" data-testid="backend-searxng-error">
                  {t('retrieval.searxngInvalid')}
                </p>
              )}
            </label>
          ) : (
            (!providerId || id !== 'zhipu') && (
              <label className="block space-y-2">
                <span className="flex items-center justify-between gap-2 text-xs text-muted">
                  {t('retrieval.key')}
                  {info.keyUrl && (
                    <a
                      href={info.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      {t('retrieval.getKey')}
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={t(state?.keySet ? 'retrieval.keySet' : 'retrieval.keyUnset')}
                  aria-label={info.name + ' ' + t('retrieval.key')}
                  disabled={disabled || busy}
                  maxLength={4000}
                  data-testid={`backend-${id}-key`}
                />
              </label>
            )
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={disabled || busy} onClick={save} data-testid={`backend-${id}-save`}>
              {t('retrieval.save')}
            </Button>
            <Button size="sm" variant="outline" disabled={disabled || busy || !ready} onClick={test} data-testid={`backend-${id}-test`}>
              {t('retrieval.test')}
            </Button>
            {id !== 'searxng' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || busy || (!state?.keySet && !state?.keyProviderId)}
                onClick={clearKey}
                data-testid={`backend-${id}-clear`}
              >
                {t('retrieval.clearKey')}
              </Button>
            )}
          </div>
          {result && (
            <p
              role="status"
              className={cn('break-words text-xs', result.ok ? 'text-accent' : 'text-danger')}
              data-testid={`backend-${id}-result`}
            >
              {result.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function SitesField({
  kind,
  value,
  save
}: {
  kind: 'trusted' | 'lowTrust'
  value: string[]
  save: (patch: Partial<RetrievalConfig>) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const savedText = value.join('\n')
  const [text, setText] = useState(savedText)
  const [dropped, setDropped] = useState(0)
  const [tooMany, setTooMany] = useState(false)
  const draft = useRef(savedText)
  const dirty = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    // 其他字段保存、或较早的保存回包，不能覆盖用户正在修改的草稿。
    if (dirty.current && draft.current !== savedText) return
    dirty.current = false
    draft.current = savedText
    setText(savedText)
  }, [savedText])
  const testId = kind === 'trusted' ? 'trusted' : 'low-trust'
  const onBlur = (current: string): void => {
    // blur 与前一次 input 可能紧接发生，取控件的当前值而不是上一轮 render 的闭包。
    draft.current = current
    dirty.current = current !== savedText
    const normalized = normalizeSiteLines(current)
    setDropped(normalized.dropped)
    setTooMany(normalized.sites.length > 200)
    if (normalized.sites.length > 200) return
    const next = normalized.sites.join('\n')
    draft.current = next
    setText(next)
    if (next === savedText) {
      dirty.current = false
      return
    }
    dirty.current = true
    const submitted = revision.current
    void save({ [kind === 'trusted' ? 'trustedSites' : 'lowTrustSites']: normalized.sites }).then(
      () => {
        if (revision.current === submitted) dirty.current = false
      },
      () => {
        /* 保留未保存的草稿；保存层已经给出失败反馈。 */
      }
    )
  }
  return (
    <label className="block space-y-2">
      <span className="text-xs text-muted">{t(`retrieval.${kind}`)}</span>
      <textarea
        value={text}
        onChange={(event) => {
          draft.current = event.currentTarget.value
          dirty.current = true
          revision.current++
          setText(event.target.value)
          setDropped(0)
          setTooMany(false)
        }}
        onBlur={(event) => onBlur(event.currentTarget.value)}
        rows={4}
        aria-label={t(`retrieval.${kind}`)}
        aria-invalid={tooMany}
        className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft disabled:opacity-50"
        data-testid={`retrieval-${testId}`}
      />
      {dropped > 0 && (
        <p role="status" className="text-xs text-muted" data-testid={`retrieval-sites-dropped-${testId}`}>
          {t('retrieval.sitesDropped', { count: dropped })}
        </p>
      )}
      {tooMany && (
        <p role="alert" className="text-xs text-danger">
          {t('retrieval.sitesTooMany')}
        </p>
      )}
    </label>
  )
}

export function RetrievalSettings() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const settingsQuery = useSettings()
  const statusQuery = useRetrievalStatus()
  const { data: providers = [] } = useProviders()
  const settings = settingsQuery.data?.retrieval
  const [limit, setLimit] = useState('')
  const [limitInvalid, setLimitInvalid] = useState(false)
  const [clearing, setClearing] = useState(false)
  const savedLimit = settings?.dailyLimit
  const limitDraft = useRef('')
  const limitDirty = useRef(false)
  const limitRevision = useRef(0)
  useEffect(() => {
    if (savedLimit === undefined) return
    const incoming = String(savedLimit)
    if (limitDirty.current && limitDraft.current !== incoming) return
    limitDirty.current = false
    limitDraft.current = incoming
    setLimit(incoming)
  }, [savedLimit])
  const update = useMutation({
    scope: { id: 'retrieval-settings' },
    mutationFn: (patch: Partial<RetrievalConfig>) => api.settings.set({ retrieval: patch }),
    onSuccess: (next) => {
      // 显示只跟随成功保存的返回值；共享的乐观设置 hook 没有失败回滚，不能在此使用。
      qc.setQueryData(keys.settings, next)
      void qc.invalidateQueries({ queryKey: retrievalKeys.all })
    },
    onError: () => toast.error(t('retrieval.saveFailed'))
  })
  const save = (patch: Partial<RetrievalConfig>): Promise<unknown> => update.mutateAsync(patch)
  const change = (patch: Partial<RetrievalConfig>): void => {
    void save(patch).catch(() => {})
  }
  const saveLimit = (current: string): void => {
    limitDraft.current = current
    limitDirty.current = true
    const number = Number(current)
    const valid = !!current.trim() && Number.isInteger(number) && number >= 10 && number <= 5000
    setLimitInvalid(!valid)
    if (!valid || !settings) return
    const next = String(number)
    limitDraft.current = next
    setLimit(next)
    if (number === settings.dailyLimit) {
      limitDirty.current = false
      return
    }
    const submitted = limitRevision.current
    void save({ dailyLimit: number }).then(
      () => {
        if (limitRevision.current === submitted) limitDirty.current = false
      },
      () => {
        /* 保留草稿，允许用户修正或再次失焦重试。 */
      }
    )
  }
  const clearCache = async (): Promise<void> => {
    if (!(await confirm({ title: t('retrieval.clearCache'), description: t('retrieval.clearConfirm') }))) return
    setClearing(true)
    try {
      await api.retrieval.clearCache()
      toast.success(t('retrieval.cleared'))
      void qc.invalidateQueries({ queryKey: retrievalKeys.all })
    } catch {
      toast.error(t('retrieval.clearFailed'))
    } finally {
      setClearing(false)
    }
  }
  if (!settings)
    return (
      <div className="py-5 text-sm text-muted" data-testid="retrieval-settings">
        <p role={settingsQuery.isError ? 'alert' : 'status'}>{t(settingsQuery.isError ? 'retrieval.loadFailed' : 'retrieval.loading')}</p>
        {settingsQuery.isError && (
          <Button variant="outline" className="mt-3" onClick={() => void settingsQuery.refetch()}>
            {t('retrieval.retry')}
          </Button>
        )}
      </div>
    )
  const enabled = statusQuery.data?.backends.filter((backend) => backend.kind === 'web' && backend.enabled) ?? []
  const statusUnavailable = !statusQuery.data || statusQuery.isError
  return (
    <div className="min-w-0 space-y-6 py-5 text-sm" data-testid="retrieval-settings">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Globe className="size-5 text-accent" />
        {t('retrieval.title')}
      </h3>
      <p className="text-xs leading-relaxed text-muted">{t('retrieval.intro')}</p>
      <Section title={t('retrieval.modeLabel')} help={t(`retrieval.modeHelp.${settings.mode}`)} helpBelow>
        <fieldset disabled={update.isPending} data-testid="retrieval-mode">
          <Segmented
            value={settings.mode}
            options={(['off', 'auto', 'always'] as const).map((value) => ({ value, label: t(`retrieval.mode.${value}`) }))}
            onChange={(mode) => change({ mode })}
            label={t('retrieval.modeLabel')}
          />
        </fieldset>
      </Section>
      <Section title={t('retrieval.servicesTitle')} help={t('retrieval.servicesHelp')}>
        {statusQuery.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
            {t('retrieval.loadFailed')}
            <Button variant="ghost" size="sm" onClick={() => void statusQuery.refetch()}>
              {t('retrieval.retry')}
            </Button>
          </div>
        )}
        <div className="space-y-2">
          {WEB_BACKENDS.map((id) => (
            <BackendCard
              key={id}
              id={id}
              state={statusQuery.data?.backends.find((backend) => backend.id === id)}
              providers={providers}
              disabled={statusUnavailable}
            />
          ))}
        </div>
      </Section>
      <Section title={t('retrieval.preferTitle')} help={t('retrieval.preferHelp')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['Zh', 'En'] as const).map((lang) => {
            const key = lang === 'Zh' ? 'preferZh' : 'preferEn'
            return (
              <label key={lang} className="block min-w-0 space-y-2">
                <span className="text-xs text-muted">{t(`retrieval.${key}`)}</span>
                <select
                  aria-label={t(`retrieval.${key}`)}
                  value={settings[key] ?? ''}
                  disabled={update.isPending || statusUnavailable}
                  onChange={(event) => change({ [key]: (event.target.value || null) as WebBackendId | null })}
                  className="h-[34px] w-full rounded-md border border-border bg-surface px-3 text-sm text-fg"
                  data-testid={`retrieval-prefer-${lang.toLowerCase()}`}
                >
                  <option value="">{t('retrieval.preferAuto')}</option>
                  {enabled.map((backend) => (
                    <option key={backend.id} value={backend.id}>
                      {BACKEND_INFO[backend.id].name}
                    </option>
                  ))}
                </select>
              </label>
            )
          })}
        </div>
      </Section>
      <Section title={t('retrieval.academicTitle')} help={t('retrieval.academicHelp')}>
        <label className="flex items-center justify-between gap-3">
          <span>{t('retrieval.academicTitle')}</span>
          <Switch
            checked={settings.academic}
            disabled={update.isPending}
            aria-label={t('retrieval.academicTitle')}
            onCheckedChange={(academic) => change({ academic })}
            data-testid="retrieval-academic"
          />
        </label>
        {settings.academic && (
          <div className="space-y-2">
            {(['openalex', 'semanticscholar'] as const).map((id) => (
              <BackendCard
                key={id}
                id={id}
                state={statusQuery.data?.backends.find((backend) => backend.id === id)}
                providers={providers}
                disabled={statusUnavailable}
                optional
              />
            ))}
          </div>
        )}
      </Section>
      <Section title={t('retrieval.privacyTitle')} help={t('retrieval.privacyHelp')}>
        <label className="flex items-center justify-between gap-3">
          <div>
            <span>{t('retrieval.cautious')}</span>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t('retrieval.cautiousHelp')}</p>
          </div>
          <Switch
            checked={settings.cautious}
            disabled={update.isPending}
            aria-label={t('retrieval.cautious')}
            onCheckedChange={(cautious) => change({ cautious })}
            data-testid="retrieval-cautious"
          />
        </label>
        {/* 保存已按 scope 串行；不能因另一个字段失焦而禁用正在获得焦点的输入框。 */}
        <SitesField kind="trusted" value={settings.trustedSites} save={save} />
        <SitesField kind="lowTrust" value={settings.lowTrustSites} save={save} />
        <button
          type="button"
          onClick={() => useApp.getState().openSettings('browser')}
          className="text-left text-xs text-accent hover:underline"
        >
          {t('retrieval.blockedLink')}
        </button>
      </Section>
      <Section title={t('retrieval.limitTitle')} help={t('retrieval.limitHelp')}>
        <label className="block space-y-2">
          <span className="text-xs text-muted">{t('retrieval.dailyLimit')}</span>
          <Input
            type="number"
            min={10}
            max={5000}
            step={1}
            value={limit}
            onChange={(event) => {
              limitDraft.current = event.currentTarget.value
              limitDirty.current = true
              limitRevision.current++
              setLimit(event.target.value)
              setLimitInvalid(false)
            }}
            onBlur={(event) => saveLimit(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            aria-label={t('retrieval.dailyLimit')}
            aria-invalid={limitInvalid}
            className="max-w-[180px]"
            data-testid="retrieval-daily-limit"
          />
          {limitInvalid && (
            <p role="alert" className="text-xs text-danger">
              {t('retrieval.dailyLimitInvalid')}
            </p>
          )}
        </label>
        <p className="text-xs text-muted" data-testid="retrieval-today-count">
          {statusQuery.data
            ? t('retrieval.todayCount', { count: statusQuery.data.today.calls })
            : t(statusQuery.isError ? 'retrieval.loadFailed' : 'retrieval.loading')}
        </p>
        <Button
          variant="outline"
          disabled={clearing}
          onClick={() => void clearCache()}
          className="h-auto max-w-full whitespace-normal py-2 text-left"
          data-testid="retrieval-clear-cache"
        >
          {t('retrieval.clearCache')}
        </Button>
      </Section>
    </div>
  )
}
