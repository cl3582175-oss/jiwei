import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Plus,
  RefreshCw,
  Trash2,
  Check,
  KeyRound,
  ExternalLink,
  Download,
  Loader2,
  CircleAlert,
  Sparkles,
  Database,
  ChevronDown,
  Plug
} from 'lucide-react'
import { PROVIDER_ORDER, PROVIDER_PRESETS, type Effort, type ProviderKind } from '@shared/ai'
import type { ProviderInfo } from '@shared/types'
import { useEmbeddingStatus, useProviders, useSettings, useUpdateSettings } from '@/lib/queries'
import { api, cn, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './ModelPicker'

const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 单个服务商：接口地址、API Key（加密保存，明文不回显）、模型列表、连接测试 */
function ProviderCard({ p, defaultOpen }: { p: ProviderInfo; defaultOpen: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const preset = PROVIDER_PRESETS[p.kind]
  const [open, setOpen] = useState(defaultOpen)
  const [baseUrl, setBaseUrl] = useState(p.baseUrl)
  const [key, setKey] = useState('')
  const [newModel, setNewModel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['providers'] })

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const save = (): Promise<void> =>
    run('save', async () => {
      await api.providers.save({ id: p.id, kind: p.kind, baseUrl, ...(key ? { apiKey: key } : {}) })
      setKey('')
      toast.success(t('ai.saved'))
    })

  const test = (): Promise<void> =>
    run('test', async () => {
      if (key || baseUrl !== p.baseUrl) await api.providers.save({ id: p.id, kind: p.kind, baseUrl, ...(key ? { apiKey: key } : {}) })
      setKey('')
      const r = await api.providers.test(p.id)
      if (r.ok) toast.success(t('ai.testOk', { ms: r.latencyMs }))
      else toast.error(t('ai.testFail', { msg: r.message ?? '' }))
    })

  const fetchModels = (): Promise<void> =>
    run('models', async () => {
      const list = await api.providers.fetchModels(p.id)
      toast.success(t('ai.modelsFetched', { count: list.length }))
    })

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('ai.removeTitle', { name: p.name }),
      description: t('ai.removeDesc'),
      confirmText: t('common.delete'),
      danger: true
    })
    if (ok) await run('remove', () => api.providers.remove(p.id))
  }

  const setModels = (models: string[]): Promise<void> => run('models', () => api.providers.save({ id: p.id, kind: p.kind, models }))

  return (
    <div className="rounded-xl border border-border bg-surface">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent">
          <Plug className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg">{p.name}</span>
          <span className="block truncate text-2xs text-subtle">{p.baseUrl}</span>
        </span>
        {p.hasKey || !preset.needsKey ? (
          <span className="inline-flex items-center gap-1 text-2xs text-accent">
            <Check className="size-3" />
            {preset.needsKey ? p.keyHint : t('ai.noKeyNeeded')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-2xs text-danger">
            <CircleAlert className="size-3" />
            {t('ai.needKey')}
          </span>
        )}
        <ChevronDown className={cn('size-4 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          <label className="block">
            <span className="mb-1.5 block text-xs text-muted">{t('ai.baseUrl')}</span>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" aria-label={t('ai.baseUrl')} />
          </label>
          {preset.needsKey && (
            <label className="block">
              <span className="mb-1.5 flex items-center justify-between text-xs text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="size-3.5" />
                  API Key
                </span>
                {preset.keyUrl && (
                  <a
                    href={preset.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    {t('ai.getKey')}
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={p.hasKey ? t('ai.keyKeep', { hint: p.keyHint }) : 'sk-…'}
                aria-label="API Key"
              />
              <span className="mt-1.5 block text-2xs text-subtle">{t('ai.keySecure')}</span>
            </label>
          )}
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
              <span>{t('ai.models')}</span>
              <button
                onClick={() => void fetchModels()}
                className="inline-flex items-center gap-1 text-accent hover:underline"
                disabled={!!busy}
              >
                <RefreshCw className={cn('size-3', busy === 'models' && 'animate-spin')} />
                {t('ai.fetchModels')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {p.models.map((m) => (
                <span
                  key={m}
                  className="group inline-flex h-6 items-center gap-1 rounded-full bg-sunken pr-1 pl-2.5 font-mono text-2xs text-muted"
                >
                  {m}
                  <button
                    onClick={() => void setModels(p.models.filter((x) => x !== m))}
                    className="rounded-full px-1 opacity-0 group-hover:opacity-100 hover:text-danger"
                    aria-label={t('common.delete')}
                  >
                    ×
                  </button>
                </span>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (newModel.trim()) void setModels([...p.models, newModel.trim()]).then(() => setNewModel(''))
                }}
              >
                <input
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  placeholder={t('ai.addModel')}
                  className="h-6 w-36 rounded-full border border-dashed border-border-strong bg-transparent px-2.5 font-mono text-2xs text-fg outline-none placeholder:font-sans placeholder:text-subtle focus:border-accent"
                />
              </form>
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-soft hover:text-danger" onClick={() => void remove()}>
              <Trash2 />
              {t('common.delete')}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void test()}>
                {busy === 'test' ? <Loader2 className="animate-spin" /> : <Plug />}
                {t('ai.test')}
              </Button>
              <Button variant="primary" size="sm" disabled={!!busy || (!key && baseUrl === p.baseUrl)} onClick={() => void save()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function EmbeddingSection() {
  const { t } = useTranslation()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const { data: st } = useEmbeddingStatus()
  const { data: providers = [] } = useProviders()
  if (!s || !st) return null
  const mode = s.ai.embedding.mode
  const install = async (): Promise<void> => {
    try {
      await api.embedding.installLocal()
    } catch (e) {
      toast.error(errText(e))
    }
  }
  const setEmb = (patch: Partial<typeof s.ai.embedding>): void => {
    update.mutate({ ai: { ...s.ai, embedding: { ...s.ai.embedding, ...patch } } })
    setTimeout(() => void api.embedding.reindex(), 300)
  }
  const cloudProviders = providers.filter(
    (p) => PROVIDER_PRESETS[p.kind].embeddingModels?.length || p.kind === 'custom' || p.kind === 'ollama'
  )

  return (
    <section className="space-y-3">
      <h4 className="flex items-center gap-2 text-sm font-medium text-fg">
        <Database className="size-4 text-accent" />
        {t('ai.kbTitle')}
      </h4>
      <p className="text-xs leading-relaxed text-muted">{t('ai.kbDesc')}</p>
      <div className="inline-flex rounded-lg border border-border bg-sunken p-0.5">
        {(['local', 'cloud'] as const).map((m) => (
          <button
            key={m}
            onClick={() => m !== mode && setEmb({ mode: m })}
            className={cn(
              'h-7 rounded-md px-3 text-xs transition-all',
              mode === m ? 'bg-surface font-medium text-fg shadow-card' : 'text-muted hover:text-fg'
            )}
          >
            {t(`ai.emb.${m}`)}
          </button>
        ))}
      </div>
      {mode === 'local' ? (
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-sm text-fg">EmbeddingGemma 2</p>
          <p className="mt-1 text-2xs leading-relaxed text-subtle">{t('ai.emb.localDesc')}</p>
          {st.state === 'downloading' || st.state === 'starting' ? (
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(st.progress * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-2xs text-subtle">
                {st.state === 'starting'
                  ? t('ai.emb.starting')
                  : t('ai.emb.downloading', {
                      pct: Math.round(st.progress * 100),
                      mirror: st.mirror ?? '…',
                      speed: st.speed ? formatBytes(st.speed) : '…'
                    })}
              </p>
            </div>
          ) : st.state === 'ready' ? (
            <div className="mt-3 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs text-accent">
                <Check className="size-3.5" />
                {t('ai.emb.ready', { indexed: st.indexed, total: st.total })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void api.embedding.reindex()}>
                <RefreshCw />
                {t('ai.emb.reindex')}
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-between gap-3">
              {st.state === 'error' && <span className="text-2xs text-danger">{st.message}</span>}
              <Button size="sm" variant="primary" className="ml-auto" onClick={() => void install()}>
                <Download />
                {t('ai.emb.install')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2 rounded-xl border border-border bg-surface p-4">
          <p className="text-2xs leading-relaxed text-subtle">{t('ai.emb.cloudDesc')}</p>
          <div className="flex gap-2">
            <select
              value={s.ai.embedding.providerId ?? ''}
              onChange={(e) =>
                setEmb({
                  providerId: e.target.value || null,
                  model: PROVIDER_PRESETS[providers.find((p) => p.id === e.target.value)?.kind ?? 'custom'].embeddingModels?.[0] ?? null
                })
              }
              className="h-8 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-fg"
              aria-label={t('ai.emb.provider')}
            >
              <option value="">{t('ai.emb.provider')}</option>
              {cloudProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Input
              className="h-8 flex-1 font-mono text-xs"
              value={s.ai.embedding.model ?? ''}
              onChange={(e) => update.mutate({ ai: { ...s.ai, embedding: { ...s.ai.embedding, model: e.target.value || null } } })}
              onBlur={() => void api.embedding.reindex()}
              placeholder={t('ai.emb.model')}
            />
          </div>
          {st.total > 0 && <p className="text-2xs text-subtle">{t('ai.emb.ready', { indexed: st.indexed, total: st.total })}</p>}
        </div>
      )}
    </section>
  )
}

/** 设置 → AI */
export function AiSettingsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const { data: providers = [], isFetched } = useProviders()
  const [justAdded, setJustAdded] = useState<string | null>(null)
  if (!s) return null

  const add = async (kind: ProviderKind): Promise<void> => {
    try {
      const p = await api.providers.save({ kind })
      setJustAdded(p.id)
      await qc.invalidateQueries({ queryKey: ['providers'] })
      // 第一个服务商自动设为默认对话模型
      if (!s.ai.chat.providerId)
        update.mutate({
          ai: { ...s.ai, chat: { providerId: p.id, model: p.models[0] ?? null }, effort: PROVIDER_PRESETS[kind].defaultEffort }
        })
    } catch (e) {
      toast.error(errText(e))
    }
  }

  return (
    <div className="space-y-8 py-4">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="flex items-center gap-2 text-sm font-medium text-fg">
            <Sparkles className="size-4 text-accent" />
            {t('ai.providers')}
          </h4>
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus />
                {t('ai.addProvider')}
              </Button>
            </MenuTrigger>
            <MenuContent className="max-h-[50vh] overflow-y-auto">
              {PROVIDER_ORDER.map((k) => (
                <MenuItem key={k} onSelect={() => void add(k)}>
                  {PROVIDER_PRESETS[k].name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
        {isFetched && providers.length === 0 && (
          <p className="rounded-xl border border-dashed border-border-strong px-4 py-5 text-center text-xs leading-relaxed text-muted">
            {t('ai.noProviders')}
          </p>
        )}
        <div className="space-y-2">
          {providers.map((p) => (
            <ProviderCard key={p.id} p={p} defaultOpen={p.id === justAdded || (!p.hasKey && PROVIDER_PRESETS[p.kind].needsKey)} />
          ))}
        </div>
      </section>

      {providers.length > 0 && (
        <section className="space-y-3">
          <h4 className="text-sm font-medium text-fg">{t('ai.defaults')}</h4>
          <div className="flex flex-wrap items-center gap-3">
            <ModelPicker value={s.ai.chat} onChange={(chat) => update.mutate({ ai: { ...s.ai, chat } })} />
            <EffortPicker
              kind={providers.find((p) => p.id === s.ai.chat.providerId)?.kind ?? 'deepseek'}
              value={s.ai.effort}
              onChange={(effort: Effort) => update.mutate({ ai: { ...s.ai, effort } })}
            />
          </div>
          <p className="text-2xs leading-relaxed text-subtle">{t('ai.effortDesc')}</p>
        </section>
      )}

      <EmbeddingSection />
    </div>
  )
}
