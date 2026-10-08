import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog as D } from 'radix-ui'
import {
  Settings2,
  Palette,
  Database,
  Info,
  X,
  Monitor,
  Sun,
  Moon,
  Check,
  FolderOpen,
  FolderInput,
  DatabaseBackup,
  TriangleAlert
} from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Input, Tip } from '@/components/ui/primitives'
import { prompt } from '@/components/ui/confirm'
import { Library, Plus, Sparkles } from 'lucide-react'
import { AiSettingsTab } from '../ai/AiSettings'
import type { Language, Palette as PaletteId, ThemeMode } from '@shared/types'
import { useAppInfo, useSettings, useUpdateSettings } from '@/lib/queries'
import { useApp } from '@/store/app'
import { api, cn, formatDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'

type Tab = 'general' | 'ai' | 'appearance' | 'data' | 'about'

const PALETTES: PaletteId[] = ['qinglu', 'celadon', 'dunhuang']

/** 配色方案卡片：卡片内部按该方案的变量渲染一个迷你界面，所见即所得 */
export function PaletteCard({ id, active, dark, onPick }: { id: PaletteId; active: boolean; dark: boolean; onPick: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onPick}
      className="group flex flex-col items-center gap-2"
      aria-pressed={active}
      aria-label={t(`settings.palettes.${id}`)}
    >
      <div
        data-palette={id}
        data-theme={dark ? 'dark' : 'light'}
        className={cn(
          'relative h-[74px] w-[120px] overflow-hidden rounded-xl p-1.5 ring-offset-2 ring-offset-surface transition-shadow',
          active ? 'ring-2 ring-[var(--accent)]' : 'ring-1 ring-border group-hover:ring-border-strong'
        )}
        style={{ background: 'var(--desk)' }}
      >
        <div className="flex h-full gap-1.5">
          <div className="flex w-5 flex-col gap-1 pt-1">
            <span className="h-2 rounded-sm" style={{ background: 'var(--accent)' }} />
            <span className="h-1.5 rounded-sm opacity-40" style={{ background: 'var(--fg-subtle)' }} />
            <span className="h-1.5 rounded-sm opacity-40" style={{ background: 'var(--fg-subtle)' }} />
          </div>
          <div className="flex-1 rounded-md p-1.5" style={{ background: 'var(--panel)', boxShadow: 'var(--shadow-1)' }}>
            <span className="block h-1.5 w-10 rounded-sm" style={{ background: 'var(--fg)' }} />
            <div className="mt-1.5 rounded-sm p-1" style={{ background: 'var(--paper)', boxShadow: 'var(--shadow-1)' }}>
              <span className="block h-1 w-12 rounded-sm opacity-50" style={{ background: 'var(--fg-muted)' }} />
              <span className="mt-1 block h-1 w-8 rounded-sm opacity-50" style={{ background: 'var(--fg-muted)' }} />
            </div>
            <span className="mt-1.5 block h-2 w-8 rounded-sm" style={{ background: 'var(--accent)' }} />
          </div>
        </div>
        {active && (
          <span
            className="absolute top-1.5 right-1.5 grid size-4 place-items-center rounded-full"
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            <Check className="size-2.5" />
          </span>
        )}
      </div>
      <span className={cn('text-xs', active ? 'font-medium text-fg' : 'text-muted')}>{t(`settings.palettes.${id}`)}</span>
    </button>
  )
}

function Row({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-border py-5 last:border-0">
      <div>
        <div className="text-sm font-medium text-fg">{label}</div>
        {desc && <div className="mt-1 max-w-[340px] text-xs leading-relaxed text-muted">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-3 text-xs transition-all [&_svg]:size-3.5',
            value === o.value ? 'bg-surface font-medium text-fg shadow-card' : 'text-muted hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function VaultsRow() {
  const { t } = useTranslation()
  const { data: vaults = [] } = useQuery({ queryKey: ['vaults'], queryFn: () => api.vaults.list() })
  const run = (p: Promise<unknown>): void =>
    void p.catch((e: unknown) =>
      toast.error(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    )
  const create = async (): Promise<void> => {
    const name = await prompt({ title: t('vaults.new'), placeholder: t('vaults.namePlaceholder'), confirmText: t('common.create') })
    if (name) run(api.vaults.create(name))
  }
  return (
    <Row label={t('vaults.title')} desc={t('vaults.desc')}>
      <div className="flex w-[260px] flex-col gap-1.5">
        {vaults.map((v) => (
          <div
            key={v.id}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2',
              v.active ? 'border-accent/40 bg-accent-soft' : 'border-border'
            )}
          >
            <Library className={cn('size-4 shrink-0', v.active ? 'text-accent' : 'text-subtle')} />
            <span className="min-w-0 flex-1 truncate text-sm text-fg" title={v.path}>
              {v.name}
            </span>
            {v.active ? (
              <span className="text-2xs text-accent">{t('vaults.current')}</span>
            ) : (
              <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => run(api.vaults.switch(v.id))}>
                {t('vaults.switch')}
              </Button>
            )}
          </div>
        ))}
        <div className="flex gap-1.5 pt-1">
          <Button size="sm" variant="outline" className="flex-1" onClick={() => void create()}>
            <Plus />
            {t('vaults.new')}
          </Button>
          <Button size="sm" variant="ghost" className="flex-1" onClick={() => run(api.vaults.open())}>
            <FolderOpen />
            {t('vaults.open')}
          </Button>
        </div>
      </div>
    </Row>
  )
}

function ProfileRow() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: () => api.profile.get() })
  if (!profile) return null
  return (
    <Row label={t('profile.name')} desc={t('profile.desc', { device: profile.deviceName })}>
      <Input
        key={profile.name}
        defaultValue={profile.name}
        className="w-[200px]"
        onBlur={(e) => {
          const name = e.target.value.trim()
          if (name && name !== profile.name) void api.profile.setName(name).then(() => qc.invalidateQueries({ queryKey: ['profile'] }))
        }}
      />
    </Row>
  )
}

function DataTab() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: info } = useAppInfo()
  const { data: backups = [] } = useQuery({ queryKey: ['backups'], queryFn: () => api.backups.list() })
  const last = backups.find((b) => b.kind === 'auto')
  if (!info) return null
  const change = async (): Promise<void> => {
    try {
      await api.app.changeDataDir()
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  const backup = async (): Promise<void> => {
    await api.backups.create()
    void qc.invalidateQueries({ queryKey: ['backups'] })
    toast.success(t('settings.backupDone'))
  }
  return (
    <>
      <VaultsRow />
      <Row
        label={t('settings.dataDir')}
        desc={
          <>
            {t('settings.dataDirDesc')}
            <code className="mt-2 block font-mono text-2xs break-all text-subtle select-text">{info.dataDir}</code>
            {info.dataDirInCloud && (
              <span className="mt-2 flex items-start gap-1.5 text-danger">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {t('settings.cloudWarning')}
              </span>
            )}
          </>
        }
      >
        <div className="flex flex-col items-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void api.app.openDataDir()}>
            <FolderOpen />
            {t('settings.openDataDir')}
          </Button>
          <Tip label={t('settings.changeDataDirDesc')} side="left">
            <Button variant="ghost" size="sm" onClick={() => void change()}>
              <FolderInput />
              {t('settings.changeDataDir')}
            </Button>
          </Tip>
        </div>
      </Row>
      <Row
        label={t('settings.backups')}
        desc={
          <>
            {t('settings.backupsDesc')}
            <span className="mt-2 block text-subtle">
              {last ? t('settings.lastBackup', { time: formatDateTime(last.createdAt, i18n.language) }) : t('settings.noBackup')}
            </span>
          </>
        }
      >
        <div className="flex flex-col items-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void backup()}>
            <DatabaseBackup />
            {t('settings.backupNow')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void api.backups.reveal()}>
            <FolderOpen />
            {t('settings.openBackups')}
          </Button>
        </div>
      </Row>
    </>
  )
}

export function SettingsDialog() {
  const { t } = useTranslation()
  const { settingsOpen, setSettingsOpen, settingsTab } = useApp()
  const { data: s } = useSettings()
  const { data: info } = useAppInfo()
  const update = useUpdateSettings()
  const [tab, setTab] = useState<Tab>('general')
  // 从其他地方跳转到指定标签页（如对话页“去设置模型”）
  useEffect(() => {
    if (settingsOpen && settingsTab) setTab(settingsTab as Tab)
  }, [settingsOpen, settingsTab])
  if (!s) return null
  const dark = document.documentElement.dataset.theme === 'dark'

  const tabs: { id: Tab; icon: ReactNode }[] = [
    { id: 'general', icon: <Settings2 /> },
    { id: 'ai', icon: <Sparkles /> },
    { id: 'appearance', icon: <Palette /> },
    { id: 'data', icon: <Database /> },
    { id: 'about', icon: <Info /> }
  ]

  return (
    <D.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
        {/* 尺寸 760 × 470 ≈ φ */}
        <D.Content className="fixed top-1/2 left-1/2 z-50 flex h-[min(88vh,560px)] w-[min(94vw,906px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-float outline-none data-[state=open]:animate-[dialog-in_220ms_cubic-bezier(0.2,0.9,0.3,1)]">
          <D.Description className="sr-only">{t('settings.title')}</D.Description>
          <nav className="w-[200px] shrink-0 border-r border-border bg-sunken p-3">
            <D.Title className="px-3 pt-2 pb-4 font-serif text-md font-semibold text-fg">{t('settings.title')}</D.Title>
            {tabs.map((it) => (
              <button
                key={it.id}
                onClick={() => setTab(it.id)}
                className={cn(
                  'mb-0.5 flex h-8 w-full items-center gap-2.5 rounded-md px-3 text-sm transition-colors [&_svg]:size-4',
                  tab === it.id ? 'bg-surface text-fg shadow-card [&_svg]:text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg'
                )}
              >
                {it.icon}
                {t(`settings.${it.id}`)}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto px-8 py-4">
            {tab === 'general' && <ProfileRow />}
            {tab === 'general' && (
              <Row label={t('settings.language')}>
                <Segmented<Language>
                  value={s.language}
                  onChange={(language) => update.mutate({ language })}
                  options={[
                    { value: 'zh-CN', label: '简体中文' },
                    { value: 'en', label: 'English' }
                  ]}
                />
              </Row>
            )}
            {tab === 'appearance' && (
              <>
                <Row label={t('settings.theme')}>
                  <Segmented<ThemeMode>
                    value={s.theme}
                    onChange={(theme) => update.mutate({ theme })}
                    options={[
                      {
                        value: 'system',
                        label: (
                          <>
                            <Monitor />
                            {t('settings.themes.system')}
                          </>
                        )
                      },
                      {
                        value: 'light',
                        label: (
                          <>
                            <Sun />
                            {t('settings.themes.light')}
                          </>
                        )
                      },
                      {
                        value: 'dark',
                        label: (
                          <>
                            <Moon />
                            {t('settings.themes.dark')}
                          </>
                        )
                      }
                    ]}
                  />
                </Row>
                <Row label={t('settings.palette')} desc={t('settings.paletteDesc')}>
                  <div className="flex gap-3">
                    {PALETTES.map((id) => (
                      <PaletteCard key={id} id={id} dark={dark} active={s.palette === id} onPick={() => update.mutate({ palette: id })} />
                    ))}
                  </div>
                </Row>
              </>
            )}
            {tab === 'ai' && <AiSettingsTab />}
            {tab === 'data' && info && <DataTab />}
            {tab === 'about' && info && (
              <div className="flex h-full flex-col items-center justify-center pb-6 text-center">
                <Logo size={56} />
                <h3 className="mt-5 font-serif text-xl font-semibold tracking-widest text-fg">{t('app.name')}</h3>
                <p className="mt-1 text-sm text-muted">{t('app.slogan')}</p>
                <p className="mt-6 text-xs text-subtle">
                  {t('settings.version')} {info.version}
                </p>
                <p className="mt-1 max-w-[360px] text-xs leading-relaxed text-subtle">{t('settings.licenseDesc')}</p>
              </div>
            )}
          </div>
          <D.Close className="absolute top-4 right-4 rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-fg">
            <X className="size-4" />
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
