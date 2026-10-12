import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check } from 'lucide-react'
import type { PluginContributionCounts, RoleBatchPreview, RoleCatalogCard } from '@shared/plugins'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PlanDialog } from '../plan/ui'
import { PluginIcon } from './PluginDetailsDialog'
import { pluginError } from './PluginConfirmDialog'

export function useRoleCatalog() {
  return useQuery({ queryKey: ['plugins', 'roles'], queryFn: () => api.plugins.roleCatalog() })
}
export function roleName(card: Pick<RoleCatalogCard, 'localizedName' | 'displayName'>, zh: boolean): string {
  return card.localizedName ? (zh ? card.localizedName.zh : card.localizedName.en) : card.displayName
}
function roleBlurb(card: RoleCatalogCard, zh: boolean): string {
  return card.localizedDescription ? (zh ? card.localizedDescription.zh : card.localizedDescription.en) : card.description
}

/** “4 个技能 · 3 个模板 · …”：只列有的 */
export function CountsLine({ counts }: { counts?: PluginContributionCounts }) {
  const { t } = useTranslation()
  if (!counts) return null
  const parts = (['skills', 'lenses', 'templates', 'frameworks', 'recipes'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => t(`plugins.count_${k}`, { count: counts[k] }))
  return (
    <p className="mt-2 flex flex-wrap gap-x-3 text-2xs text-subtle">
      {parts.map((x) => (
        <span key={x} className="whitespace-nowrap">
          {x}
        </span>
      ))}
    </p>
  )
}

/** 角色卡片网格，分“学生 / 工作”两组。已启用的角色不可再选，点它看详情。 */
export function RoleGrid({
  selected,
  onToggle,
  onInstalled
}: {
  selected: string[]
  onToggle: (id: string) => void
  onInstalled?: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const { data = [], isPending, error } = useRoleCatalog()
  if (isPending)
    return (
      <div role="status" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="h-24 animate-pulse rounded-xl bg-sunken" />
        ))}
      </div>
    )
  if (error)
    return (
      <p role="alert" className="text-sm text-danger">
        {pluginError(error)}
      </p>
    )
  const groups = (['student', 'work', 'other'] as const).map((g) => ({ g, cards: data.filter((c) => c.group === g) }))
  return (
    <div className="space-y-5" data-testid="role-grid">
      {groups
        .filter((x) => x.cards.length)
        .map(({ g, cards }) => (
          <section key={g}>
            <h3 className="mb-2 text-xs font-medium text-muted">{t(`plugins.roleGroup_${g}`)}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {cards.map((c) => {
                const installed = c.enabled !== null
                const on = selected.includes(c.id)
                return (
                  <button
                    key={c.id}
                    data-role-id={c.id}
                    aria-pressed={installed ? undefined : on}
                    disabled={!c.supported || (installed && !onInstalled)}
                    onClick={() => (installed ? onInstalled?.(c.id) : onToggle(c.id))}
                    className={cn(
                      'relative flex min-w-0 gap-3 rounded-xl border bg-surface p-4 text-left transition-colors',
                      on ? 'border-accent bg-accent-soft/40' : 'border-border hover:border-accent/40 hover:bg-surface-hover',
                      'disabled:cursor-default disabled:opacity-70'
                    )}
                  >
                    <PluginIcon icon={c.icon} name={roleName(c, zh)} category="role" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">{roleName(c, zh)}</span>
                        {installed && (
                          <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-2xs text-muted">
                            {t(c.enabled ? 'plugins.enabled' : 'plugins.disabled')}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">{roleBlurb(c, zh)}</span>
                      <CountsLine counts={c.counts} />
                    </span>
                    {!installed && (
                      <span
                        aria-hidden
                        className={cn(
                          'grid size-5 shrink-0 place-items-center rounded-full border transition-colors [&_svg]:size-3',
                          on ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong'
                        )}
                      >
                        {on && <Check />}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
    </div>
  )
}

/** 一次确认多个角色包：列出每个包会添加的内容和订阅源，逐个安装（已装好的不会因后面失败而撤回） */
export function RoleBatchDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const qc = useQueryClient()
  const { data: catalog = [] } = useRoleCatalog()
  const token = useRef<string | null>(null)
  const [preview, setPreview] = useState<RoleBatchPreview | null>(null),
    [feeds, setFeeds] = useState<Record<string, number[]>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const tk = await api.plugins.beginRoleSelection()
        token.current = tk
        const p = await api.plugins.previewRoles(tk, ids)
        if (!live) return
        setPreview(p)
        setFeeds(Object.fromEntries(p.roles.map((r) => [r.id, r.feeds.map((_, i) => i)])))
      } catch (e) {
        if (live) setError(pluginError(e))
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const cancel = (): void => {
    if (busy) return
    if (token.current) void api.plugins.cancelRoleSelection(token.current).catch(() => undefined)
    onClose()
  }
  const confirm = async (): Promise<void> => {
    if (!preview || !token.current) return
    setBusy(true)
    setError('')
    try {
      const r = await api.plugins.confirmRoles(
        token.current,
        preview.roles.map((p) => ({ id: p.id, options: { feeds: feeds[p.id] ?? [], config: {} } }))
      )
      await qc.invalidateQueries({ queryKey: ['plugins'] })
      if (r.status === 'complete') {
        toast.success(t('plugins.rolesInstalled', { count: r.installed.length }))
        onDone()
      } else setError(t('plugins.rolesPartial', { installed: r.installed.length, remaining: r.remaining.length, error: r.error ?? '' }))
    } catch (e) {
      setError(pluginError(e))
    } finally {
      setBusy(false)
    }
  }
  const nameOf = (id: string): string => {
    const card = catalog.find((c) => c.id === id)
    return card ? roleName(card, zh) : id.split('@')[0]
  }
  return (
    <PlanDialog
      title={t('plugins.rolesConfirmTitle', { count: ids.length })}
      description={t('plugins.rolesConfirmHint')}
      size="lg"
      onClose={cancel}
      testId="role-batch-confirm"
      footer={
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" disabled={busy} onClick={cancel}>
            {t('plugins.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !preview} onClick={() => void confirm()}>
            {busy ? t('plugins.installing') : t('plugins.install')}
          </Button>
        </div>
      }
    >
      {!preview && !error && (
        <div role="status" className="space-y-3">
          {ids.map((id) => (
            <div key={id} className="h-20 animate-pulse rounded-xl bg-sunken" />
          ))}
        </div>
      )}
      {preview?.alreadyInstalled.length ? (
        <p className="text-xs text-muted">{t('plugins.rolesAlready', { names: preview.alreadyInstalled.map(nameOf).join('、') })}</p>
      ) : null}
      {preview?.roles.map((r) => {
        const textOnly = !r.capabilities.servers.length && !r.capabilities.dataLeavesDevice && !r.capabilities.cost
        const lenses = r.skills.filter((s) => s.kind === 'lens').length
        return (
          <section key={r.id} className="space-y-2 rounded-xl border border-border p-4" data-role-preview={r.id}>
            <div className="flex items-center gap-3">
              <PluginIcon name={nameOf(r.id)} category="role" />
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-fg">{nameOf(r.id)}</h3>
                {textOnly && (
                  <p data-tint="bamboo" className="text-xs text-[var(--tint-ink)]">
                    {t('plugins.textOnly')}
                  </p>
                )}
              </div>
            </div>
            <CountsLine
              counts={{
                skills: r.skills.length - lenses,
                lenses,
                templates: r.templates.length,
                frameworks: r.frameworks.length,
                recipes: r.recipes.length,
                feeds: r.feeds.length,
                starters: r.starters.length
              }}
            />
            {r.recipes.length > 0 && <p className="text-xs text-muted">{t('plugins.recipesOff')}</p>}
            {r.feeds.length > 0 && (
              <fieldset className="space-y-1.5">
                <legend className="text-xs text-muted">{t('plugins.feedsHint')}</legend>
                {r.feeds.map((f, i) => (
                  <label key={f.url} className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={feeds[r.id]?.includes(i) ?? false}
                      onChange={(e) =>
                        setFeeds((m) => ({
                          ...m,
                          [r.id]: e.target.checked ? [...(m[r.id] ?? []), i] : (m[r.id] ?? []).filter((x) => x !== i)
                        }))
                      }
                    />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {f.title}
                      <span className="block text-2xs text-subtle">{f.url}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </section>
        )
      })}
      {error && (
        <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </PlanDialog>
  )
}

/** 设置 → 插件 → 角色 */
export function RolesPanel({ onInstalledDetails }: { onInstalledDetails: (id: string) => void }) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string[]>([]),
    [confirming, setConfirming] = useState(false)
  return (
    <div className="space-y-4" data-testid="roles-panel">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted">{t('plugins.rolesHint')}</p>
        <Button variant="primary" size="sm" disabled={!selected.length} onClick={() => setConfirming(true)}>
          {selected.length ? t('plugins.installSelected', { count: selected.length }) : t('plugins.pickRoles')}
        </Button>
      </div>
      <RoleGrid
        selected={selected}
        onToggle={(id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
        onInstalled={onInstalledDetails}
      />
      {confirming && (
        <RoleBatchDialog
          ids={selected}
          onClose={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false)
            setSelected([])
          }}
        />
      )}
    </div>
  )
}
