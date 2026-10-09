import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
  Plug,
  AudioLines,
  Eye,
  Zap,
  X,
  ScanText,
  Globe
} from 'lucide-react'
import { PROVIDER_ORDER, PROVIDER_PRESETS, resolveCaps, type Effort, type ModelCapsOverride, type ProviderKind } from '@shared/ai'
import type { ProviderInfo } from '@shared/types'
import { useEmbeddingStatus, useProviders, useSettings, useUpdateSettings } from '@/lib/queries'
import { api, cn, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './ModelPicker'
import { Switch } from '@/components/ui/switch'
import { useRecognitionEvents } from '../workspace/RecognitionBar'

const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 单个服务商：接口地址、API Key（加密保存，明文不回显）、模型列表、连接测试 */
/**
 * 一个模型的能力：能否看图、强 / 普通。默认按名称自动判断；点击切换为相反值，
 * 切换回与自动判断相同时即恢复“自动”（不留下多余的设定）。
 */
function ModelRow({
  p,
  model,
  onCaps,
  onRemove
}: {
  p: ProviderInfo
  model: string
  onCaps: (caps: Record<string, ModelCapsOverride>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const caps = resolveCaps(model, p.modelCaps)
  const set = (patch: ModelCapsOverride): void => {
    const next: ModelCapsOverride = { ...p.modelCaps[model], ...patch }
    if (next.vision === caps.auto.vision) delete next.vision
    if (next.tier === caps.auto.tier) delete next.tier
    const all = { ...p.modelCaps, [model]: next }
    if (!Object.keys(next).length) delete all[model]
    onCaps(all)
  }
  const custom = (k: 'vision' | 'tier'): boolean => p.modelCaps[model]?.[k] !== undefined
  const chip = (on: boolean, overridden: boolean): string =>
    cn(
      'relative inline-flex h-6 items-center gap-1 rounded-full px-2 text-2xs transition-colors [&_svg]:size-3',
      on ? 'bg-accent-soft text-accent' : 'text-subtle hover:bg-sunken hover:text-muted',
      overridden && 'ring-1 ring-accent/40'
    )
  const how = (k: 'vision' | 'tier'): string => (custom(k) ? t('ai.caps.custom') : t('ai.caps.auto'))
  return (
    <li className="group flex h-9 items-center gap-2 rounded-lg px-2.5 hover:bg-surface-hover" data-model={model}>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{model}</span>
      <Tip label={`${caps.vision ? t('ai.caps.visionOn') : t('ai.caps.visionOff')} · ${how('vision')}`}>
        <button
          className={chip(caps.vision, custom('vision'))}
          aria-pressed={caps.vision}
          aria-label={`${model} ${t('ai.caps.vision')}`}
          onClick={() => set({ vision: !caps.vision })}
        >
          <Eye />
          {t('ai.caps.vision')}
        </button>
      </Tip>
      <Tip label={`${caps.tier === 'strong' ? t('ai.caps.strongOn') : t('ai.caps.strongOff')} · ${how('tier')}`}>
        <button
          className={chip(caps.tier === 'strong', custom('tier'))}
          aria-pressed={caps.tier === 'strong'}
          aria-label={`${model} ${t('ai.caps.strong')}`}
          onClick={() => set({ tier: caps.tier === 'strong' ? 'basic' : 'strong' })}
        >
          <Zap />
          {t('ai.caps.strong')}
        </button>
      </Tip>
      <button
        onClick={onRemove}
        className="grid size-6 place-items-center rounded-md text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100 [&_svg]:size-3.5"
        aria-label={`${t('common.delete')} ${model}`}
      >
        <X />
      </button>
    </li>
  )
}

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
  const setCaps = (modelCaps: Record<string, ModelCapsOverride>): Promise<void> =>
    run('caps', () => api.providers.save({ id: p.id, kind: p.kind, modelCaps }))

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
            <ul className="-mx-2.5 mb-2">
              {p.models.map((m) => (
                <ModelRow
                  key={m}
                  p={p}
                  model={m}
                  onCaps={(c) => void setCaps(c)}
                  onRemove={() => void setModels(p.models.filter((x) => x !== m))}
                />
              ))}
            </ul>
            <p className="mb-2 text-2xs leading-relaxed text-subtle">{t('ai.caps.hint')}</p>
            <div className="flex flex-wrap gap-1.5">
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
/** 视频 / 音频转写：本地（离线）或云端（OpenAI 兼容接口，音频会上传） */
const ASR_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-large-v3-turbo', 'FunAudioLLM/SenseVoiceSmall']

function MossSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['moss'], queryFn: () => api.moss.status() })
  useEffect(() => window.jiweiEvents.on('moss:status', (s) => qc.setQueryData(['moss'], s)), [qc])
  return (
    <div className="space-y-2 rounded-xl border border-border p-3" data-testid="moss-settings">
      <p className="text-xs font-medium">{t('course.mossTitle')}</p>
      <p className="text-2xs text-muted">{t('course.mossHint')}</p>
      <p role="status" className="text-xs text-muted">
        {status?.state === 'downloading'
          ? t('course.downloading', { p: Math.round(status.progress * 100) })
          : status?.running
            ? t('course.running')
            : t(`course.${status?.state ?? 'missing'}`, { defaultValue: status?.message ?? '' })}
      </p>
      {status?.message && <p className="text-2xs text-danger">{status.message}</p>}
      <div className="flex gap-2">
        {status?.state !== 'ready' && (
          <Tip label={t('course.mossDownload')}>
            <Button
              size="sm"
              aria-label={t('course.install')}
              disabled={status?.state === 'downloading' || status?.state === 'unsupported'}
              onClick={() => void api.moss.install().catch((e: unknown) => toast.error(errText(e)))}
            >
              <Download />
              {t('course.install')}
            </Button>
          </Tip>
        )}
        {status?.state === 'ready' && (
          <Tip label={t('course.remove')}>
            <Button
              size="sm"
              aria-label={t('course.remove')}
              disabled={status.running}
              onClick={() => void api.moss.remove().catch((e: unknown) => toast.error(errText(e)))}
            >
              <Trash2 />
              {t('course.remove')}
            </Button>
          </Tip>
        )}
      </div>
    </div>
  )
}

function TranscriptionSection() {
  const { t } = useTranslation()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const { data: providers = [] } = useProviders()
  if (!s) return null
  const tr = s.ai.transcription ?? { mode: 'local' as const, providerId: null, model: null }
  const set = (patch: Partial<typeof tr>): void => update.mutate({ ai: { ...s.ai, transcription: { ...tr, ...patch } } })
  const usable = providers.filter((p) => p.kind !== 'deepseek' && p.kind !== 'anthropic')
  return (
    <section className="space-y-3">
      <h4 className="flex items-center gap-2 text-sm font-medium text-fg">
        <AudioLines className="size-4 text-accent" />
        {t('ai.asr.title')}
      </h4>
      <p className="text-xs leading-relaxed text-muted">{t('ai.asr.desc')}</p>
      <MossSection />
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('ai.asr.title')}>
        {(['local', 'cloud'] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={tr.mode === m}
            onClick={() => set({ mode: m })}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs transition-colors',
              tr.mode === m ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:text-fg'
            )}
          >
            {t(`ai.asr.${m}`)}
          </button>
        ))}
      </div>
      {tr.mode === 'cloud' && (
        <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t('ai.asr.provider')}
              value={tr.providerId ?? ''}
              onChange={(e) => set({ providerId: e.target.value || null })}
              className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-fg"
            >
              <option value="">{t('ai.asr.pickProvider')}</option>
              {usable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Input
              aria-label={t('ai.asr.model')}
              list="asr-models"
              placeholder="whisper-1"
              defaultValue={tr.model ?? ''}
              onBlur={(e) => set({ model: e.target.value.trim() || null })}
              className="h-8 w-[240px] text-xs"
            />
            <datalist id="asr-models">
              {ASR_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-muted">
            <CircleAlert className="mt-px size-3 shrink-0 text-[#b8862b]" />
            {t('ai.asr.privacy')}
          </p>
        </div>
      )}
    </section>
  )
}

/** 文档识别：本地（LightOnOCR，离线，按需运行）、云端看图模型或关闭；插图解读只用云端 */
function RecognitionSection() {
  const { t } = useTranslation()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const { data: providers = [] } = useProviders()
  useRecognitionEvents()
  const { data: st } = useQuery({ queryKey: ['recognizer'], queryFn: () => api.recognition.status() })
  if (!s) return null
  const rc = s.ai.recognition ?? {
    mode: 'local' as const,
    providerId: null,
    model: null,
    auto: true,
    figures: true,
    localModel: 'fast' as const
  }
  const set = (patch: Partial<typeof rc>): void => update.mutate({ ai: { ...s.ai, recognition: { ...rc, ...patch } } })
  // 能看图的模型（服务商 / 模型）
  const vision = providers.flatMap((p) => p.models.filter((m) => resolveCaps(m, p.modelCaps).vision).map((m) => ({ p, m })))
  return (
    <section className="space-y-3" data-testid="recognition-settings">
      <h4 className="flex items-center gap-2 text-sm font-medium text-fg">
        <ScanText className="size-4 text-accent" />
        {t('ai.ocr.title')}
      </h4>
      <p className="text-xs leading-relaxed text-muted">{t('ai.ocr.desc')}</p>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('ai.ocr.title')}>
        {(['local', 'cloud', 'off'] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={rc.mode === m}
            onClick={() => set({ mode: m })}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs transition-colors',
              rc.mode === m ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:text-fg'
            )}
          >
            {t(`ai.ocr.${m}`)}
          </button>
        ))}
      </div>
      {rc.mode === 'local' && (
        <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
          <p className="text-2xs leading-relaxed text-muted">{t('ai.ocr.localHint')}</p>
          <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label={t('ai.ocr.localModel')}>
            {(['fast', 'accurate'] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={(rc.localModel ?? 'fast') === m}
                onClick={() => set({ localModel: m })}
                className={cn(
                  'rounded-lg border px-3 py-2 text-left transition-colors',
                  (rc.localModel ?? 'fast') === m ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong'
                )}
              >
                <span className={cn('block text-xs font-medium', (rc.localModel ?? 'fast') === m ? 'text-accent' : 'text-fg')}>
                  {t(`ai.ocr.models.${m}.name`)}
                </span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-muted">{t(`ai.ocr.models.${m}.desc`)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {st?.state === 'ready' ? (
              <>
                <span className="flex items-center gap-1.5 text-xs text-fg">
                  <Check className="size-3.5 text-accent" />
                  {t('ai.ocr.ready', { model: st.model ?? '' })}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void api.recognition.remove()}>
                  <Trash2 />
                  {t('ai.ocr.remove')}
                </Button>
              </>
            ) : st?.state === 'downloading' ? (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Loader2 className="size-3.5 animate-spin" />
                {t('ai.ocr.downloading', { percent: Math.floor(st.progress * 100) })}
              </span>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void api.recognition.install()}>
                <Download />
                {t('ai.ocr.download', { size: formatBytes(st?.size ?? 0) })}
              </Button>
            )}
          </div>
          {st?.state === 'error' && st.message && <p className="text-2xs text-danger">{st.message}</p>}
        </div>
      )}
      {rc.mode !== 'off' && (
        <div className="space-y-2.5 rounded-xl border border-border bg-surface p-3">
          {rc.mode === 'cloud' && (
            <div className="space-y-1.5">
              <select
                aria-label={t('ai.ocr.cloud')}
                value={rc.providerId && rc.model ? `${rc.providerId}\u0000${rc.model}` : ''}
                onChange={(e) => {
                  const [providerId, model] = e.target.value ? e.target.value.split('\u0000') : [null, null]
                  set({ providerId, model })
                }}
                className="h-8 max-w-full rounded-lg border border-border bg-surface px-2 text-xs text-fg"
              >
                <option value="">{t('ai.ocr.pickModel')}</option>
                {vision.map(({ p, m }) => (
                  <option key={`${p.id}:${m}`} value={`${p.id}\u0000${m}`}>
                    {p.name} · {m}
                  </option>
                ))}
              </select>
              <p className="text-2xs leading-relaxed text-muted">{t('ai.ocr.cloudHint')}</p>
            </div>
          )}
          <label className="flex items-center justify-between gap-3 text-xs text-fg">
            {t('ai.ocr.auto')}
            <Switch checked={rc.auto} aria-label={t('ai.ocr.auto')} onCheckedChange={(auto) => set({ auto })} />
          </label>
          <div>
            <label className="flex items-center justify-between gap-3 text-xs text-fg">
              {t('ai.ocr.figures')}
              <Switch checked={rc.figures} aria-label={t('ai.ocr.figures')} onCheckedChange={(figures) => set({ figures })} />
            </label>
            <p className="mt-1 text-2xs leading-relaxed text-muted">{t('ai.ocr.figuresHint')}</p>
          </div>
        </div>
      )}
    </section>
  )
}

/** 内置浏览器（v0.6.0）：主动程度、不发送给 AI 的网站、搜索引擎 */
const ENGINES = [
  { id: 'bing', url: 'https://cn.bing.com/search?q=' },
  { id: 'baidu', url: 'https://www.baidu.com/s?wd=' },
  { id: 'google', url: 'https://www.google.com/search?q=' },
  { id: 'duckduckgo', url: 'https://duckduckgo.com/?q=' }
]

function BrowserSection() {
  const { t } = useTranslation()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const [sites, setSites] = useState<string | null>(null)
  if (!s) return null
  const b = s.browser ?? {}
  const set = (patch: Partial<NonNullable<typeof s.browser>>): void => update.mutate({ browser: { ...b, ...patch } })
  const engine = ENGINES.find((e) => e.url === (b.searchEngine ?? ENGINES[0].url))?.id ?? 'bing'
  return (
    <section className="space-y-3" data-testid="browser-settings">
      <h4 className="flex items-center gap-2 text-sm font-medium text-fg">
        <Globe className="size-4 text-accent" />
        {t('browser.settings.title')}
      </h4>
      <p className="text-xs leading-relaxed text-muted">{t('browser.settings.desc')}</p>
      <div className="space-y-2 rounded-xl border border-border p-3">
        <p className="text-xs font-medium">{t('course.title')}</p>
        <p className="text-2xs text-muted">{t('course.settingsHint')}</p>
        {(['autoTimestamp', 'autoSlides', 'quiz'] as const).map((key) => {
          const course = b.course ?? { autoTimestamp: true, autoSlides: true, quiz: false }
          return (
            <label key={key} className="flex items-center justify-between gap-3 text-xs">
              <span>{t(`course.${key}`)}</span>
              <Tip label={t(`course.${key}`)}>
                <Switch
                  aria-label={t(`course.${key}`)}
                  checked={course[key]}
                  onCheckedChange={(checked) => set({ course: { ...course, [key]: checked } })}
                />
              </Tip>
            </label>
          )
        })}
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-fg">{t('browser.settings.proactivity')}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('browser.settings.proactivity')}>
          {(['quiet', 'balanced', 'active'] as const).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={(b.proactivity ?? 'balanced') === p}
              onClick={() => set({ proactivity: p })}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                (b.proactivity ?? 'balanced') === p ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:text-fg'
              )}
            >
              {t(`browser.settings.p.${p}`)}
            </button>
          ))}
        </div>
        <p className="text-2xs leading-relaxed text-muted">{t(`browser.settings.pHint.${b.proactivity ?? 'balanced'}`)}</p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs text-fg">{t('browser.settings.blocked')}</span>
        <textarea
          aria-label={t('browser.settings.blocked')}
          rows={3}
          value={sites ?? (b.aiBlockedSites ?? []).join('\n')}
          placeholder="company.cn&#10;wiki.example.com"
          onChange={(e) => setSites(e.target.value)}
          onBlur={() => {
            if (sites === null) return
            set({
              aiBlockedSites: [
                ...new Set(
                  sites
                    .split(/[\s,，]+/)
                    .map((x) =>
                      x
                        .trim()
                        .replace(/^https?:\/\//, '')
                        .replace(/\/.*$/, '')
                    )
                    .filter(Boolean)
                )
              ]
            })
            setSites(null)
          }}
          className="w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-xs text-fg outline-none focus:border-accent"
        />
        <span className="block text-2xs leading-relaxed text-muted">{t('browser.settings.blockedHint')}</span>
      </label>
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg">{t('browser.settings.engine')}</span>
        <select
          aria-label={t('browser.settings.engine')}
          value={engine}
          onChange={(e) => set({ searchEngine: ENGINES.find((x) => x.id === e.target.value)!.url })}
          className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-fg"
        >
          {ENGINES.map((e) => (
            <option key={e.id} value={e.id}>
              {t(`browser.settings.engines.${e.id}`)}
            </option>
          ))}
        </select>
      </div>
    </section>
  )
}

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
      <TranscriptionSection />
      <RecognitionSection />
      <BrowserSection />
    </div>
  )
}
