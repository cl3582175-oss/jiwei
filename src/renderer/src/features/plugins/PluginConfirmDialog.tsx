import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog as D } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import type { PluginConfig, PluginInfo, PluginManifest, PluginPreview } from '@shared/plugins'
import { Button } from '@/components/ui/button'
import { field } from '../plan/ui'
import { api } from '@/lib/utils'

export const pluginError = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export function PluginOriginLabel({ origin }: { origin: PluginInfo['origin'] }) {
  const { t } = useTranslation()
  // jiwei 是 main 保留的市场身份，不能由插件声明自行取得。
  return (
    <span className="text-xs text-muted">
      {origin.market === 'jiwei'
        ? t('plugins.official')
        : origin.kind === 'local'
          ? t('plugins.local')
          : `${t('plugins.market')} · ${origin.market}`}
    </span>
  )
}
export function PluginConfigFields({
  manifest,
  values,
  onChange,
  presence = {}
}: {
  manifest: PluginManifest
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  presence?: Record<string, boolean>
}) {
  const { t } = useTranslation()
  const fields = Object.entries(manifest.userConfig ?? {})
  if (!fields.length) return null
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{t('plugins.config')}</legend>
      <p className="text-xs text-muted">{t('plugins.configHint')}</p>
      {fields.map(([key, f]) => (
        <label key={key} className="block text-xs text-muted">
          {f.title} {f.required && `· ${t('plugins.required')}`}{' '}
          {f.sensitive && `· ${t('plugins.encrypted')} · ${t(presence[key] ? 'plugins.configured' : 'plugins.unset')}`}
          {f.multiple && !f.sensitive ? (
            <textarea
              aria-label={f.title}
              className={field}
              value={values[key] ?? ''}
              placeholder={t('plugins.multiple')}
              onChange={(e) => onChange(key, e.target.value)}
            />
          ) : f.type === 'boolean' && !f.sensitive ? (
            <select aria-label={f.title} className={field} value={values[key] ?? ''} onChange={(e) => onChange(key, e.target.value)}>
              <option value="">—</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              aria-label={f.title}
              type={f.sensitive ? 'password' : f.type === 'number' && !f.multiple ? 'number' : 'text'}
              autoComplete="off"
              className={field}
              value={values[key] ?? ''}
              placeholder={f.multiple ? t('plugins.multiple') : undefined}
              onChange={(e) => onChange(key, e.target.value)}
            />
          )}
          <span className="mt-1 block">{f.description}</span>
          {f.options && <span className="block">{f.options.join(' / ')}</span>}
        </label>
      ))}
    </fieldset>
  )
}
/** 不预填敏感值；只传用户在当前表单修改的字段。 */
export function pluginConfigPatch(manifest: PluginManifest, fields: Record<string, string>): PluginConfig {
  const result: PluginConfig = {}
  for (const [key, raw] of Object.entries(fields)) {
    if (!raw.trim()) continue
    const f = manifest.userConfig?.[key]
    if (!f) continue
    const parse = (v: string): string | number | boolean => {
      if (f.type === 'number') {
        const n = Number(v)
        if (!Number.isFinite(n)) throw new Error('Invalid number')
        return n
      }
      if (f.type === 'boolean') {
        if (v !== 'true' && v !== 'false') throw new Error('Invalid boolean')
        return v === 'true'
      }
      return v
    }
    result[key] = f.multiple
      ? raw
          .split(/\n/)
          .filter((v) => v.trim())
          .map((v) => parse(v) as string | number)
      : parse(raw)
  }
  return result
}
function Items({ title, items }: { title: string; items: ReactNode[] }) {
  if (!items.length) return null
  return (
    <details className="rounded-lg border border-border px-3 py-2 text-xs">
      <summary className="cursor-pointer">
        {title} · {items.length}
      </summary>
      <ul className="mt-2 space-y-1 text-muted">
        {items.map((x, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">
            {x}
          </li>
        ))}
      </ul>
    </details>
  )
}
export function PluginConfirmDialog({
  preview,
  current,
  onClose,
  onInstalled
}: {
  preview: PluginPreview
  current?: PluginInfo
  onClose: () => void
  onInstalled: (plugin: PluginInfo) => void
}) {
  const { t, i18n } = useTranslation()
  const [feeds, setFeeds] = useState<number[]>(preview.feeds.map((_, i) => i))
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [spent, setSpent] = useState(false)
  const [phase, setPhase] = useState('verify'),
    [canceling, setCanceling] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null),
    installRef = useRef<HTMLButtonElement>(null)
  const c = preview.capabilities,
    highRisk = !!(c.commands.length || c.dataLeavesDevice || c.cost)
  const zh = i18n.language.startsWith('zh'),
    local = (v: { zh: string; en: string }) => (zh ? v.zh : v.en)
  useEffect(
    () =>
      window.jiweiEvents.on('plugins:progress', (e) => {
        if (e.id === preview.id) setPhase(e.phase)
      }),
    [preview.id]
  )
  const close = async (): Promise<void> => {
    setCanceling(true)
    try {
      await api.plugins.cancel(preview.token)
      if (!busy) onClose()
    } catch (e) {
      setError(pluginError(e))
    } finally {
      setCanceling(false)
    }
  }
  const install = async (): Promise<void> => {
    if (busy || spent) return
    let config: PluginConfig
    try {
      config = pluginConfigPatch(preview.manifest, fields)
    } catch {
      setError(t('plugins.configInvalid'))
      return
    }
    setBusy(true)
    setError('')
    setSpent(true)
    try {
      const plugin = await api.plugins.confirmInstall(preview.token, { feeds, config })
      setFields({})
      onInstalled(plugin)
    } catch (e) {
      setFields({})
      if (pluginError(e).includes('Plugin installation canceled')) onClose()
      else setError(`${t('plugins.failed')} ${pluginError(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const commands = (items: string[]) =>
    items.map((item) => {
      try {
        const [cmd, args] = JSON.parse(item)
        return [cmd, ...(args ?? [])].join(' ')
      } catch {
        return item
      }
    })
  return (
    <D.Root
      open
      onOpenChange={(v) => {
        if (!v) void close()
      }}
    >
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
        <D.Content
          data-testid="plugin-confirm"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(highRisk ? cancelRef : installRef).current?.focus()
          }}
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            void close()
          }}
          onInteractOutside={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing &&
              !['BUTTON', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)
            ) {
              e.preventDefault()
              void install()
            }
          }}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(94vw,640px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-surface text-fg shadow-float outline-none"
        >
          <header className="shrink-0 space-y-1 border-b border-border px-5 py-4">
            <D.Title className="truncate font-serif text-lg" title={preview.manifest.displayName ?? preview.manifest.name}>
              {preview.manifest.displayName ?? preview.manifest.name} · {preview.version}
            </D.Title>
            <PluginOriginLabel origin={preview.origin} />
            {preview.origin.market !== 'jiwei' && <p className="text-xs text-warning">{t('plugins.thirdParty')}</p>}
          </header>
          <div className="min-h-0 space-y-4 overflow-y-auto p-5 [overflow-wrap:anywhere]">
            <section className="space-y-2" aria-label={t('plugins.capabilities')}>
              {c.commands.length > 0 && (
                <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                  <p>{t('plugins.commandsRisk')}</p>
                  {commands(c.commands).map((cmd, i) => (
                    <p key={i} className="mt-1 font-mono">
                      {cmd}
                    </p>
                  ))}
                </div>
              )}
              {c.dataLeavesDevice && <p className="text-sm text-warning">{t('plugins.leaves')}</p>}
              {c.cost && <p className="text-sm text-warning">{local(c.cost)}</p>}
              {!c.servers.length && !c.dataLeavesDevice && !c.cost && (
                <p data-tint="bamboo" className="text-sm text-[var(--tint-ink)]">
                  {t('plugins.textOnly')}
                </p>
              )}
              {!!c.domains.length && (
                <p className="text-xs text-muted">
                  {t('plugins.domains')}：{c.domains.join(', ')}
                </p>
              )}
              {!!c.servers.length && <p className="text-xs text-muted">{t('plugins.mcpDisabled')}</p>}
            </section>
            {current && Object.keys(preview.added).length > 0 && (
              <section className="rounded-lg border border-warning/40 p-3 text-xs text-warning">
                <h3>{t('plugins.added')}</h3>
                {Object.entries(preview.added).map(([k, v]) => (
                  <p key={k}>
                    {t(
                      `plugins.${k === 'commands' ? 'programs' : k === 'sensitive' ? 'credentials' : k === 'dataLeavesDevice' ? 'leaves' : k}`
                    )}
                    :{' '}
                    {k === 'commands'
                      ? commands(v as string[]).join('; ')
                      : k === 'sensitive'
                        ? (v as string[]).map((key) => preview.manifest.userConfig?.[key]?.title ?? key).join(', ')
                        : k === 'cost' && v
                          ? local(v as { zh: string; en: string })
                          : Array.isArray(v)
                            ? v.join(', ')
                            : k === 'dataLeavesDevice'
                              ? ''
                              : String(v)}
                  </p>
                ))}
              </section>
            )}
            <section className="space-y-2 text-xs text-muted">
              <D.Description className="whitespace-pre-wrap">{preview.manifest.description ?? t('plugins.contents')}</D.Description>
              <p>{typeof preview.manifest.author === 'string' ? preview.manifest.author : preview.manifest.author?.name}</p>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('plugins.contents')}</h3>
              {(['skill', 'command', 'lens'] as const).map((kind, i) => (
                <Items
                  key={kind}
                  title={t(`plugins.${['skills', 'commands', 'lenses'][i]}`)}
                  items={preview.skills
                    .filter((s) => s.kind === kind || (kind === 'skill' && !['command', 'lens'].includes(s.kind)))
                    .map((s) => `${s.name}${s.hasScripts ? ` · ${t('plugins.scripts')}` : ''}`)}
                />
              ))}
              <Items title={t('plugins.templates')} items={preview.templates.map((v) => local(v.title))} />
              <Items title={t('plugins.frameworks')} items={preview.frameworks.map((v) => local(v.title))} />
              <Items title={t('plugins.recipes')} items={preview.recipes.map((v) => local(v.name))} />
              <Items title={t('plugins.servers')} items={c.servers} />
            </section>
            {!!preview.feeds.length && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  {t('plugins.feeds')} · {preview.feeds.length}
                </legend>
                <p className="text-xs text-muted">{t('plugins.feedsHint')}</p>
                {preview.feeds.map((f, i) => (
                  <label key={i} className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      disabled={busy || spent}
                      checked={feeds.includes(i)}
                      onChange={(e) => setFeeds(e.target.checked ? [...feeds, i] : feeds.filter((v) => v !== i))}
                    />
                    <span>
                      {f.title}
                      <span className="block text-muted">{f.url}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <fieldset disabled={busy || spent}>
              <PluginConfigFields
                manifest={preview.manifest}
                values={fields}
                onChange={(key, value) => setFields({ ...fields, [key]: value })}
                presence={current?.sensitive}
              />
            </fieldset>
            <Items title={t('plugins.unsupported')} items={c.unsupported} />
            <Items title={t('plugins.scripts')} items={preview.scripts} />
            <Items title={t('plugins.issues')} items={preview.issues.map((x) => `${x.path}: ${x.message}`)} />
            {busy && (
              <p role="status" className="text-sm text-accent">
                {t(canceling ? 'plugins.canceling' : phase === 'install' ? 'plugins.installing' : `plugins.${phase}`)}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </div>
          <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            <Button ref={cancelRef} disabled={canceling} onClick={() => void close()}>
              {t('plugins.cancel')}
            </Button>
            <Button ref={installRef} variant="primary" disabled={busy || spent} onClick={() => void install()}>
              {t(current ? 'plugins.update' : 'plugins.install')}
            </Button>
          </footer>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
