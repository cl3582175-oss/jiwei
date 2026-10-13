import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog as D } from 'radix-ui'
import { Check, ChevronDown, CircleAlert, ClipboardPaste, ExternalLink, Loader2, Lock, Sparkles, Star, X } from 'lucide-react'
import { PROVIDER_PRESETS, type ProviderKind } from '@shared/ai'
import type { AsrStatus, ProviderInfo, Settings } from '@shared/types'
import { useEmbeddingStatus, useProviders, useSettings, useUpdateSettings } from '@/lib/queries'
import { api, cn, formatBytes } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Input, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/primitives'

// 模型配置引导：首次启动引导、未配置时的顶部横幅、功能入口拦截共用。
// 对普通用户只要求一件事——填一个 API Key；向量、识别、听写等能力用本地模型，在清单里一键准备。

/** 默认对话模型已选好、服务商可用（有 Key 或不需要 Key） */
export function isAiReady(s: Settings | undefined, providers: ProviderInfo[] | undefined): boolean {
  const { providerId, model } = s?.ai.chat ?? {}
  if (!providerId || !model) return false
  const p = providers?.find((x) => x.id === providerId)
  return !!p && p.enabled && (p.hasKey || !PROVIDER_PRESETS[p.kind].needsKey)
}

export function useAiReady(): { ready: boolean; loaded: boolean } {
  const { data: s } = useSettings()
  const { data: providers, isFetched } = useProviders()
  return { ready: isAiReady(s, providers), loaded: !!s && isFetched }
}

/** 引导卡片上直接展示的服务商；其余放在「更多」 */
const FEATURED: ProviderKind[] = ['deepseek', 'qwen']
const MORE: ProviderKind[] = ['moonshot', 'zhipu', 'openai', 'anthropic', 'google', 'ollama']

/** 预设没有内置模型时，从拉取到的列表里挑一个常用的作为默认 */
const PREFERRED: Partial<Record<ProviderKind, RegExp[]>> = {
  qwen: [/^qwen-plus$/, /^qwen-plus/, /^qwen-max/],
  moonshot: [/^kimi-k2/, /^kimi/, /^moonshot-v1-32k/],
  zhipu: [/^glm-4\.\d+$/, /^glm-4/],
  openai: [/^gpt-[\d.]+-mini$/, /^gpt-[\d.]+$/],
  anthropic: [/sonnet/, /haiku/],
  google: [/^gemini-[\d.]+-flash$/, /flash/]
}

function pickModel(kind: ProviderKind, list: string[]): string | null {
  for (const re of PREFERRED[kind] ?? []) {
    const m = list.find((x) => re.test(x))
    if (m) return m
  }
  return list[0] ?? null
}

const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 把连接失败的原因翻译成普通人能看懂、知道下一步怎么做的话 */
function friendlyError(raw: string, t: (k: string) => string): string {
  if (/无效|没有权限|401|403|invalid|unauthor/i.test(raw)) return t('modelSetup.errKey')
  if (/402|余额|insufficient|balance|quota/i.test(raw)) return t('modelSetup.errBalance')
  if (/timeout|timed out|ENOTFOUND|ECONN|net::|fetch failed|network/i.test(raw)) return t('modelSetup.errNetwork')
  return raw
}

/** 看起来像 API Key 的剪贴板内容（不同服务商格式不一，只做宽松判断） */
const looksLikeKey = (s: string): boolean => /^[\w.-]{20,200}$/.test(s) && /^(sk-|AIza|sk_)/.test(s)

type Phase = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; model: string } | { state: 'fail'; msg: string }

/** 「给积微接上 AI 大脑」：选服务商 → 三步拿 Key → 粘贴即自动测试 */
export function ModelSetupCard({ onConnected }: { onConnected?: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const { data: providers = [] } = useProviders()
  const ready = isAiReady(s, providers)
  const current = providers.find((p) => p.id === s?.ai.chat.providerId)
  const [kind, setKind] = useState<ProviderKind>(current?.kind ?? 'deepseek')
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState<Phase>({ state: 'idle' })
  const [clip, setClip] = useState<string | null>(null)
  const preset = PROVIDER_PRESETS[kind]
  const busy = phase.state === 'testing'

  // 从浏览器复制完 Key 切回来时，提示一键粘贴
  const keyRef = useRef(key)
  keyRef.current = key
  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        const text = (await navigator.clipboard.readText()).trim()
        setClip(looksLikeKey(text) && text !== keyRef.current ? text : null)
      } catch {
        /* 无剪贴板权限：不提示 */
      }
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  const choose = (k: ProviderKind): void => {
    setKind(k)
    setKey('')
    setPhase({ state: 'idle' })
  }

  const connect = async (apiKey: string): Promise<void> => {
    if (!s || busy) return
    const k = apiKey.trim()
    if (preset.needsKey && !k) return
    setPhase({ state: 'testing' })
    try {
      const existing = providers.find((p) => p.kind === kind)
      const p = await api.providers.save({
        ...(existing ? { id: existing.id } : {}),
        kind,
        enabled: true,
        ...(preset.needsKey ? { apiKey: k } : {})
      })
      const r = await api.providers.test(p.id)
      if (!r.ok) {
        setPhase({ state: 'fail', msg: friendlyError(r.message ?? '', t) })
        return
      }
      let models = p.models
      if (!models.length) models = await api.providers.fetchModels(p.id).catch(() => [])
      const model = preset.models[0] ?? pickModel(kind, models)
      if (!model) {
        setPhase({ state: 'fail', msg: t('modelSetup.errNoModel') })
        return
      }
      await update.mutateAsync({ ai: { ...s.ai, chat: { providerId: p.id, model }, effort: preset.defaultEffort } })
      setKey('')
      setClip(null)
      setPhase({ state: 'ok', model })
      onConnected?.()
    } catch (e) {
      setPhase({ state: 'fail', msg: friendlyError(errText(e), t) })
    } finally {
      await qc.invalidateQueries({ queryKey: ['providers'] })
    }
  }

  const cardCls = (active: boolean): string =>
    cn(
      'rounded-2xl border p-4 text-left transition-colors',
      active ? 'border-accent bg-accent-soft/60 shadow-[var(--shadow-1)]' : 'border-border bg-surface hover:border-border-strong'
    )

  return (
    <div className="space-y-5" data-testid="model-setup">
      <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-3">
        {FEATURED.map((k, i) => (
          <button key={k} onClick={() => choose(k)} className={cardCls(kind === k)} data-testid={`setup-${k}`}>
            <span className="flex items-center gap-1.5 font-display text-md font-semibold text-fg">
              {i === 0 && <Star className="size-3.5 fill-current text-accent" />}
              {PROVIDER_PRESETS[k].name}
              {i === 0 && <span className="rounded-full bg-accent px-1.5 py-px text-2xs font-normal text-white">{t('modelSetup.recommended')}</span>}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">{t(`modelSetup.pitch.${k}`)}</span>
          </button>
        ))}
        <Menu>
          <MenuTrigger asChild>
            <button className={cardCls(!FEATURED.includes(kind))}>
              <span className="flex items-center gap-1 font-display text-md font-semibold text-fg">
                {FEATURED.includes(kind) ? t('modelSetup.more') : PROVIDER_PRESETS[kind].name}
                <ChevronDown className="size-3.5 text-muted" />
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted">
                {FEATURED.includes(kind) ? t('modelSetup.moreDesc') : t(`modelSetup.pitch.${kind}`)}
              </span>
            </button>
          </MenuTrigger>
          <MenuContent>
            {MORE.map((k) => (
              <MenuItem key={k} onSelect={() => choose(k)}>
                {PROVIDER_PRESETS[k].name}
              </MenuItem>
            ))}
            <MenuItem onSelect={() => useApp.getState().openSettings('ai')}>{t('modelSetup.advanced')}</MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {phase.state === 'ok' || (ready && current?.kind === kind && phase.state === 'idle') ? (
        <div className="flex items-start gap-3 rounded-2xl bg-surface p-4 shadow-[var(--shadow-1)]" data-testid="setup-ok">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white">
            <Check className="size-4" />
          </span>
          <div className="text-sm">
            <p className="font-medium text-fg">{t('modelSetup.ok')}</p>
            <p className="mt-0.5 text-xs text-muted">
              {t('modelSetup.okDesc', {
                name: PROVIDER_PRESETS[kind].name,
                model: phase.state === 'ok' ? phase.model : (s?.ai.chat.model ?? '')
              })}
            </p>
          </div>
        </div>
      ) : (
        <ol className="space-y-3 rounded-2xl bg-surface p-5 shadow-[var(--shadow-1)]">
          {preset.needsKey ? (
            <>
              <Step n={1} title={t('modelSetup.s1', { name: preset.name })} hint={t(`modelSetup.signup.${kind}`)}>
                {preset.keyUrl && (
                  <a
                    href={preset.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-accent hover:bg-accent-soft"
                  >
                    {t('modelSetup.openSite', { name: preset.name })}
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </Step>
              <Step n={2} title={t('modelSetup.s2')} hint={t('modelSetup.s2Hint')} />
              <Step n={3} title={t('modelSetup.s3')}>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    placeholder={kind === 'google' ? 'AIza…' : 'sk-…'}
                    disabled={busy}
                    onChange={(e) => {
                      setKey(e.target.value)
                      if (phase.state === 'fail') setPhase({ state: 'idle' })
                    }}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData('text').trim()
                      if (!text) return
                      e.preventDefault()
                      setKey(text)
                      void connect(text)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && void connect(key)}
                    className="max-w-[360px] font-mono"
                    data-testid="setup-key"
                  />
                  <Button variant="primary" disabled={busy || !key.trim()} onClick={() => void connect(key)}>
                    {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                    {busy ? t('modelSetup.testing') : t('modelSetup.connect')}
                  </Button>
                </div>
                {clip && !busy && (
                  <button
                    onClick={() => {
                      setKey(clip)
                      void connect(clip)
                    }}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent-soft px-2.5 py-1 text-xs text-accent"
                  >
                    <ClipboardPaste className="size-3.5" />
                    {t('modelSetup.clipFound', { tail: clip.slice(-4) })}
                  </button>
                )}
                <p className="mt-2 flex items-center gap-1 text-2xs text-subtle">
                  <Lock className="size-3" />
                  {t('modelSetup.safe')}
                </p>
              </Step>
            </>
          ) : (
            <Step n={1} title={t('modelSetup.ollamaTitle')} hint={t('modelSetup.ollamaHint')}>
              <Button variant="primary" disabled={busy} onClick={() => void connect('')}>
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {busy ? t('modelSetup.testing') : t('modelSetup.connect')}
              </Button>
            </Step>
          )}
          {phase.state === 'fail' && (
            <p className="flex items-start gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="setup-error">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              {phase.msg}
            </p>
          )}
        </ol>
      )}
    </div>
  )
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-xs font-medium text-muted">{n}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm text-fg">{title}</p>
        {hint && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
        {children}
      </div>
    </li>
  )
}

type Row = { id: string; state: 'ok' | 'busy' | 'idle' | 'error' | 'off'; note: string; action?: () => void }

/** 其余能力的准备清单：智能搜索自动下载，识别图片文字与听写一键下载，播客语音用到时再下载 */
export function PrepChecklist({ autoStart = true }: { autoStart?: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: s } = useSettings()
  const { ready } = useAiReady()
  const { data: emb } = useEmbeddingStatus()
  const { data: ocr } = useQuery({ queryKey: ['recognizer'], queryFn: () => api.recognition.status() })
  const { data: asr } = useQuery<AsrStatus>({ queryKey: ['asr'], queryFn: () => api.asr.status() })
  useEffect(() => {
    const offs = [
      window.jiweiEvents.on('recognition:status', (st) => qc.setQueryData(['recognizer'], st)),
      window.jiweiEvents.on('asr:status', (st) => qc.setQueryData(['asr'], st))
    ]
    return () => offs.forEach((off) => off())
  }, [qc])

  // 智能搜索是知识库问答的基础，体积适中（约 310 MB），进入清单即开始下载
  const started = useRef(false)
  useEffect(() => {
    if (!autoStart || started.current || !emb || emb.mode !== 'local' || emb.state !== 'missing') return
    started.current = true
    void api.embedding.installLocal().catch(() => {})
  }, [autoStart, emb])

  if (!s) return null
  const pct = (p: number): string => `${Math.round(p * 100)}%`
  const speed = (v: number | null): string => (v ? ` · ${formatBytes(v)}/s` : '')
  const ocrMode = s.ai.recognition?.mode ?? 'local'

  const rows: Row[] = [
    { id: 'brain', state: ready ? 'ok' : 'idle', note: ready ? t('modelSetup.prep.brainOk') : t('modelSetup.prep.brainTodo') },
    !emb
      ? { id: 'search', state: 'busy', note: '' }
      : emb.mode === 'cloud'
        ? { id: 'search', state: emb.state === 'ready' ? 'ok' : 'idle', note: t('modelSetup.prep.cloud') }
        : emb.state === 'ready'
          ? { id: 'search', state: 'ok', note: t('modelSetup.prep.ready') }
          : emb.state === 'downloading'
            ? { id: 'search', state: 'busy', note: t('modelSetup.prep.downloading', { pct: pct(emb.progress) }) + speed(emb.speed) }
            : emb.state === 'starting'
              ? { id: 'search', state: 'busy', note: t('modelSetup.prep.starting') }
              : emb.state === 'error'
                ? { id: 'search', state: 'error', note: t('modelSetup.prep.failed'), action: () => void api.embedding.installLocal().catch(() => {}) }
                : {
                    id: 'search',
                    state: 'idle',
                    note: t('modelSetup.prep.size', { size: '310 MB' }),
                    action: () => void api.embedding.installLocal().catch(() => {})
                  },
    ocrMode !== 'local'
      ? { id: 'ocr', state: ocrMode === 'off' ? 'off' : 'ok', note: t(ocrMode === 'off' ? 'modelSetup.prep.off' : 'modelSetup.prep.cloud') }
      : !ocr
        ? { id: 'ocr', state: 'busy', note: '' }
        : ocr.state === 'ready'
          ? { id: 'ocr', state: 'ok', note: t('modelSetup.prep.ready') }
          : ocr.state === 'downloading'
            ? { id: 'ocr', state: 'busy', note: t('modelSetup.prep.downloading', { pct: pct(ocr.progress) }) + speed(ocr.speed) }
            : {
                id: 'ocr',
                state: ocr.state === 'error' ? 'error' : 'idle',
                note: ocr.state === 'error' ? t('modelSetup.prep.failed') : t('modelSetup.prep.size', { size: formatBytes(ocr.size) }),
                action: () => void api.recognition.install()
              },
    !asr
      ? { id: 'listen', state: 'busy', note: '' }
      : asr.state === 'ready'
        ? { id: 'listen', state: 'ok', note: t('modelSetup.prep.ready') }
        : asr.state === 'downloading'
          ? { id: 'listen', state: 'busy', note: t('modelSetup.prep.downloading', { pct: pct(asr.progress) }) + speed(asr.speed) }
          : {
              id: 'listen',
              state: asr.state === 'error' ? 'error' : 'idle',
              note: asr.state === 'error' ? t('modelSetup.prep.failed') : t('modelSetup.prep.size', { size: '260 MB' }),
              action: () => void api.asr.install()
            },
    { id: 'voice', state: 'off', note: t('modelSetup.prep.onDemand') }
  ]

  return (
    <ul className="divide-y divide-border/70 rounded-2xl bg-surface shadow-[var(--shadow-1)]" data-testid="prep-checklist">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
          <span
            className={cn(
              'grid size-5 shrink-0 place-items-center rounded-full',
              r.state === 'ok' && 'bg-accent text-white',
              r.state === 'busy' && 'text-accent',
              r.state === 'error' && 'text-danger',
              (r.state === 'idle' || r.state === 'off') && 'border border-border-strong'
            )}
          >
            {r.state === 'ok' && <Check className="size-3" />}
            {r.state === 'busy' && <Loader2 className="size-4 animate-spin" />}
            {r.state === 'error' && <CircleAlert className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">{t(`modelSetup.prep.${r.id}`)}</p>
            <p className="text-2xs text-muted">{t(`modelSetup.prep.${r.id}Desc`)}</p>
          </div>
          <span className="shrink-0 text-2xs text-muted tabular-nums">{r.note}</span>
          {r.action && r.id !== 'brain' && (
            <Button size="sm" variant="outline" onClick={r.action}>
              {r.state === 'error' ? t('modelSetup.prep.retry') : t('modelSetup.prep.download')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** 独立的模型配置对话框：横幅与功能入口打开 */
export function ModelSetupDialog() {
  const { t } = useTranslation()
  const open = useApp((s) => s.modelSetupOpen)
  const { ready } = useAiReady()
  const close = (): void => useApp.setState({ modelSetupOpen: false })
  return (
    <D.Root open={open} onOpenChange={(o) => !o && close()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[var(--desk)]/60 backdrop-blur-sm" />
        <D.Content className="paper fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(94vw,760px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl p-8 shadow-[var(--shadow-4)] outline-none">
          <D.Close className="absolute top-5 right-5 text-subtle hover:text-fg" aria-label={t('common.close')}>
            <X className="size-4" />
          </D.Close>
          <D.Title className="font-display text-xl font-semibold tracking-[0.06em] text-fg">{t('modelSetup.title')}</D.Title>
          <D.Description className="mt-2 mb-6 text-sm leading-relaxed text-muted">{t('modelSetup.desc')}</D.Description>
          <ModelSetupCard />
          {ready && (
            <>
              <h3 className="mt-7 mb-3 text-sm font-medium text-fg">{t('modelSetup.prep.title')}</h3>
              <PrepChecklist />
              <div className="mt-6 flex justify-end">
                <Button variant="primary" onClick={close}>
                  {t('modelSetup.done')}
                </Button>
              </div>
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 没有可用的 AI 时常驻在页面底部的提示条（占据自己的位置，不遮挡页面）；本次运行可暂时收起 */
export function ModelSetupBanner() {
  const { t } = useTranslation()
  const { data: s } = useSettings()
  const { ready, loaded } = useAiReady()
  const [hidden, setHidden] = useState(false)
  if (!loaded || ready || hidden || !s?.onboarded) return null
  return (
    <div
      className="flex h-10 shrink-0 items-center justify-center gap-3 border-t border-border/70 bg-accent-soft/50 px-4 text-xs"
      data-testid="model-setup-banner"
    >
      <CircleAlert className="size-3.5 text-accent" />
      <span className="text-fg">{t('modelSetup.banner')}</span>
      <Button size="sm" variant="primary" onClick={() => useApp.getState().openModelSetup()}>
        {t('modelSetup.bannerAction')}
      </Button>
      <button onClick={() => setHidden(true)} className="text-subtle hover:text-fg" aria-label={t('common.close')}>
        <X className="size-3.5" />
      </button>
    </div>
  )
}
