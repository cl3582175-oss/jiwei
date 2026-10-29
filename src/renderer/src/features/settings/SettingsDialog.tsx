import { PluginUpdateDot } from '../plugins/PluginMarketplace'
import { AboutSettings } from '../update/UpdateSettings'
import { ImportLibraryButton } from '../import/ImportWizard'
import { Puzzle } from 'lucide-react'
import { PluginsSettings } from '../plugins/PluginsSettings'
import { RetrievalSettings } from '../retrieval/RetrievalSettings'
import { DiscoverSettings } from '../discover/DiscoverSettings'
import { TasksSettings } from '../tasks/TasksSettings'
import { BackupSettings } from './BackupSettings'
import { ActivitySettings } from '../today/ActivitySettings'
import { BrowserSafetySettings } from './BrowserSafetySettings'
import { RecordingSecurity } from '../recording/RecordingSecurity'
import { CaptureSettings } from '../capture/CaptureSettings'
import { TranslationCacheSettings } from '../reading/ReadingSettings'
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings2,
  Palette,
  Database,
  UserRound,
  Wand2,
  Info,
  X,
  Monitor,
  Sun,
  Moon,
  Check,
  FolderOpen,
  FolderInput,
  TriangleAlert,
  Layers,
  Globe
} from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Tip } from '@/components/ui/shadcn-primitives'
import { confirm, prompt, useConfirmSignal, withActionLock } from '@/components/ui/shadcn-confirm'
import { Bot, Cable, Compass, Gauge, Glasses, Library, Plus, Sparkles } from 'lucide-react'
import { UsageSettings } from '@/features/agent/UsageSettings'
import { ConnectionsSettings } from '@/features/agent/ConnectionsSettings'
import { AiSettingsTab } from '../ai/AiSettings'
import { SkillsSettingsTab } from '../ai/SkillsSettings'
import { LensSettings } from '../lenses/LensSettings'
import { MemorySettingsTab } from '../memory/MemorySettings'
import type { Language, Palette as PaletteId, Profile, ThemeMode } from '@shared/types'
import { flushSettings, settingsDirty, useAppInfo, useSettings, useUpdateSettings } from '@/lib/queries'
import { useApp } from '@/store/app'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/shadcn-button'
import { Switch } from '@/components/ui/shadcn-switch'
import { Input } from '@/components/ui/input'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Segmented } from '@/components/ui/segmented'
import { settingsTransition } from '@/lib/settingsTransition'
import { useSettingsField } from '@/lib/useSettingsField'
import { useSettingsDraft } from '@/lib/useSettingsDraft'
import { settingsMessages } from './settingsMessages'
import { useResolvedTheme } from '@/lib/theme'

type Tab =
  | 'plugins'
  | 'discover'
  | 'tasks'
  | 'general'
  | 'me'
  | 'learning'
  | 'ai'
  | 'skills'
  | 'lenses'
  | 'appearance'
  | 'usage'
  | 'connections'
  | 'search'
  | 'data'
  | 'browser'
  | 'about'

const PALETTES: PaletteId[] = ['qinglu', 'celadon', 'dunhuang']
const TAB_IDS: readonly Tab[] = [
  'plugins',
  'discover',
  'tasks',
  'general',
  'me',
  'learning',
  'ai',
  'skills',
  'lenses',
  'appearance',
  'usage',
  'connections',
  'search',
  'data',
  'browser',
  'about'
]
const isTab = (value: string): value is Tab => TAB_IDS.some((tab) => tab === value)

/** 配色方案卡片：卡片内部按该方案的变量渲染一个迷你界面，所见即所得 */
export function PaletteCard({ id, active, dark, onPick }: { id: PaletteId; active: boolean; dark: boolean; onPick: () => void }) {
  const { t } = useTranslation()
  return (
    <Button
      variant="ghost"
      size="auto"
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
    </Button>
  )
}

function Row({ label, desc, error, children }: { label: ReactNode; desc?: ReactNode; error?: ReactNode; children: ReactNode }) {
  const id = useId()
  const labelId = `${id}-label`
  const describedBy = [desc && `${id}-description`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  const control = isValidElement<{ id?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>(
    children
  )
    ? cloneElement(children, {
        id: children.props.id ?? `${id}-control`,
        'aria-labelledby': labelId,
        'aria-describedby': [children.props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined,
        'aria-invalid': !!error || children.props['aria-invalid']
      })
    : children
  return (
    <Field
      orientation="horizontal"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      data-invalid={!!error || undefined}
      className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b border-border py-5 last:border-0"
    >
      <FieldContent className="min-w-[160px] flex-1">
        <FieldLabel id={labelId} htmlFor={`${id}-control`} className="text-sm font-medium text-fg">
          {label}
        </FieldLabel>
        {desc && (
          <FieldDescription id={`${id}-description`} className="mt-1 max-w-[340px] text-xs leading-relaxed text-muted">
            {desc}
          </FieldDescription>
        )}
        {error && (
          <FieldError id={`${id}-error`} className="mt-1 text-xs text-danger">
            {error}
          </FieldError>
        )}
      </FieldContent>
      <div className="max-w-full shrink-0">{control}</div>
    </Field>
  )
}

export { Segmented } from '@/components/ui/segmented'

function VaultsRow() {
  const signal = useConfirmSignal('vaults')
  const { t } = useTranslation()
  const { data: vaults = [] } = useQuery({ queryKey: ['vaults'], queryFn: () => api.vaults.list() })
  const run = (p: Promise<unknown>): void =>
    void p.catch((e: unknown) =>
      toast.error(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    )
  const create = async (): Promise<void> => {
    await withActionLock(
      'vault:create',
      async () => {
        await prompt({
          operationKey: 'vault:create',
          signal: signal,
          title: t('vaults.new'),
          placeholder: t('vaults.namePlaceholder'),
          confirmText: t('common.create'),
          submit: async (name) => {
            if (name) await api.vaults.create(name)
          }
        })
      },
      { signal: signal }
    )
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
          <Button size="sm" variant="secondary" className="flex-1" onClick={() => void create()}>
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
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: () => api.profile.get() })
  if (!profile) return null
  return <ProfileNameField profile={profile} />
}

function ProfileNameField({ profile }: { profile: Profile }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const messages = settingsMessages(i18n.language)
  const name = useSettingsDraft({
    key: 'profile.name',
    value: profile.name,
    validate: (value) => (!value.trim() || value.trim().length > 60 ? messages.nameRequired : null),
    persist: async (value) => {
      await api.profile.setName(value.trim())
      void qc.invalidateQueries({ queryKey: ['profile'] })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : messages.failed)
  })
  return (
    <Row
      label={t('profile.name')}
      desc={t('profile.desc', { device: profile.deviceName })}
      error={name.dirty && (!name.draft.trim() || name.draft.trim().length > 60) ? messages.nameRequired : undefined}
    >
      <Input value={name.draft} className="w-[200px]" onChange={(event) => name.change(event.target.value)} onBlur={name.blur} />
    </Row>
  )
}

function DataTab() {
  const { t } = useTranslation()
  const { data: info } = useAppInfo()
  if (!info) return null
  const change = async (): Promise<void> => {
    try {
      await api.app.changeDataDir()
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  return (
    <>
      <VaultsRow />
      <TranslationCacheSettings />
      <ActivitySettings />
      <Row
        label={t('settings.dataDir')}
        desc={
          <>
            {t('settings.dataDirDesc')}
            <code className="mt-2 block font-mono text-xs break-all text-subtle select-text">{info.dataDir}</code>
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
          <Button variant="secondary" size="sm" onClick={() => void api.app.openDataDir()}>
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
      <Row label={t('importer.title')} desc={t('importer.settingsDesc')}>
        <ImportLibraryButton />
      </Row>
      <RecordingSecurity />
      <BackupSettings />
    </>
  )
}

export function SettingsDialog() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { settingsOpen, setSettingsOpen, settingsTab } = useApp()
  const { data: s } = useSettings()
  const { data: info } = useAppInfo()
  const update = useUpdateSettings()
  const [tab, setTab] = useState<Tab>('general')
  const activeTabRef = useRef<HTMLButtonElement>(null)
  const initialFocusRequest = useRef(0)
  const transition = useSyncExternalStore(settingsTransition.subscribe, settingsTransition.getSnapshot)
  const messages = settingsMessages(i18n.language)
  const signal = useConfirmSignal(settingsOpen ? tab : null)
  useSettingsField('settings.pending-writes', {
    dirty: () => settingsOpen && settingsDirty(qc),
    flush: () => flushSettings(qc)
  })
  // 从其他地方跳转到指定标签页（如对话页“去设置模型”）
  useEffect(() => {
    if (settingsOpen && settingsTab && isTab(settingsTab)) setTab(settingsTab)
  }, [settingsOpen, settingsTab])
  const dark = useResolvedTheme(s?.theme ?? 'system') === 'dark'
  if (!s) return null

  const tabs: { id: Tab; icon: ReactNode }[] = [
    { id: 'general', icon: <Settings2 /> },
    { id: 'me', icon: <UserRound /> },
    { id: 'learning', icon: <Layers /> },
    { id: 'ai', icon: <Sparkles /> },
    { id: 'skills', icon: <Wand2 /> },
    { id: 'plugins', icon: <Puzzle /> },
    { id: 'lenses', icon: <Glasses /> },
    { id: 'appearance', icon: <Palette /> },
    { id: 'usage', icon: <Gauge /> },
    { id: 'connections', icon: <Cable /> },
    { id: 'search', icon: <Globe /> },
    { id: 'tasks', icon: <Bot /> },
    { id: 'discover', icon: <Compass /> },
    { id: 'data', icon: <Database /> },
    { id: 'browser', icon: <Monitor /> },
    { id: 'about', icon: <Info /> }
  ]

  return (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        void setSettingsOpen(open)
      }}
    >
      {/* 尺寸 760 × 470 ≈ φ */}
      {/* Settings owns its layout/motion; omit the generic centered animation. */}
      <DialogContent
        placement="custom"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          const content = event.target
          if (!(content instanceof HTMLElement) || !activeTabRef.current) return
          event.preventDefault()
          const previousFocus = document.activeElement
          const request = ++initialFocusRequest.current
          // Let the modal's mount effects finish before focus forces style/layout.
          // A microtask still focuses and scrolls the selected tab before the first paint.
          queueMicrotask(() => {
            const activeTab = activeTabRef.current
            if (
              request !== initialFocusRequest.current ||
              !useApp.getState().settingsOpen ||
              !content.isConnected ||
              content.dataset.state !== 'open' ||
              content.closest('[aria-hidden="true"], [inert]') ||
              (document.activeElement !== previousFocus && document.activeElement !== document.body) ||
              !activeTab?.isConnected ||
              !content.contains(activeTab)
            )
              return
            activeTab.focus()
          })
        }}
        onCloseAutoFocus={() => {
          initialFocusRequest.current++
        }}
        aria-busy={transition.pending}
        className="fixed top-[calc(50%+22px)] left-1/2 z-50 flex h-[min(88vh,560px)] max-h-[calc(100dvh-60px)] w-[min(94vw,906px)] -translate-x-1/2 -translate-y-1/2 gap-0 overflow-hidden rounded-2xl border border-border bg-surface p-0 shadow-float outline-none data-[state=open]:animate-[dialog-in_220ms_cubic-bezier(0.2,0.9,0.3,1)]"
      >
        <DialogDescription className="sr-only">{t('settings.title')}</DialogDescription>
        <Tabs
          value={tab}
          orientation="vertical"
          activationMode="manual"
          onValueChange={(next) => {
            if (!isTab(next) || next === tab) return
            void settingsTransition.request(`tab:${next}`, () => {
              setTab(next)
              useApp.setState({ settingsTab: next })
            })
          }}
          className="flex min-h-0 w-full gap-0"
        >
          <nav className="safety-ui w-[200px] shrink-0 overflow-y-auto border-r border-border bg-sunken p-3">
            <DialogTitle className="px-3 pt-2 pb-4 font-serif text-md font-semibold text-fg">{t('settings.title')}</DialogTitle>
            <TabsList aria-label={t('settings.title')} className="flex h-auto w-full items-stretch justify-start gap-0 bg-transparent p-0">
              {tabs.map((it) => (
                <TabsTrigger key={it.id} ref={tab === it.id ? activeTabRef : undefined} value={it.id} variant="navigation">
                  <span aria-hidden="true">{it.icon}</span>
                  {it.id === 'search'
                    ? t('retrieval.title')
                    : it.id === 'plugins'
                      ? t('plugins.title')
                      : it.id === 'discover'
                        ? t('discover.title')
                        : it.id === 'tasks'
                          ? t('tasks.title')
                          : it.id === 'browser'
                            ? t('settings.browserTab')
                            : it.id === 'usage' || it.id === 'connections'
                              ? t(`agent.tabs.${it.id}`)
                              : t(`settings.${it.id}`)}
                  {it.id === 'plugins' && <PluginUpdateDot />}
                </TabsTrigger>
              ))}
            </TabsList>
          </nav>
          <TabsContent value={tab} className="min-w-0 flex-1 overflow-y-auto px-8 py-4">
            {transition.pending && (
              <p role="status" className="sr-only">
                {messages.saving}
              </p>
            )}
            {!!transition.error && (
              <div
                role="alert"
                data-testid="settings-leave-error"
                className="sticky top-0 z-10 mb-3 rounded-lg border border-danger/40 bg-surface p-3 text-xs text-fg shadow-card"
              >
                <p className="font-medium text-danger">{messages.failed}</p>
                <p className="mt-1 leading-relaxed text-muted">{messages.retained}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" onClick={() => void settingsTransition.retry()}>
                    {messages.retry}
                  </Button>
                  <Button size="sm" onClick={() => settingsTransition.continueEditing()}>
                    {messages.edit}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void withActionLock(
                        'settings:discard',
                        async () => {
                          if (
                            await confirm({
                              title: messages.discardTitle,
                              description: messages.discardDescription,
                              confirmText: messages.discard,
                              danger: true,
                              operationKey: 'settings:discard',
                              signal
                            })
                          )
                            await settingsTransition.discard()
                        },
                        { signal }
                      )
                    }
                  >
                    {messages.discard}
                  </Button>
                </div>
              </div>
            )}
            <fieldset disabled={transition.pending} className="m-0 min-w-0 border-0 p-0">
              {tab === 'search' && <RetrievalSettings />}
              {tab === 'discover' && <DiscoverSettings />}
              {tab === 'tasks' && <TasksSettings />}
              {tab === 'plugins' && <PluginsSettings />}
              {tab === 'browser' && <BrowserSafetySettings />}
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
              {tab === 'general' && (
                <>
                  <Row label={t('tasks.login')}>
                    <Switch
                      checked={s.tasks.launchAtLogin}
                      onCheckedChange={(launchAtLogin) => update.mutate({ tasks: { launchAtLogin } })}
                    />
                  </Row>
                  <Row label={t('tasks.keepRunning')}>
                    <Switch checked={s.tasks.keepRunning} onCheckedChange={(keepRunning) => update.mutate({ tasks: { keepRunning } })} />
                  </Row>
                </>
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
              {tab === 'learning' && (
                <>
                  <h3 className="pt-4 font-serif text-md font-semibold text-fg">{t('review.settingsTitle')}</h3>
                  <Row label={t('review.newPerDay')} desc={t('review.newPerDayDesc')}>
                    <Segmented<string>
                      value={String(s.review.newPerDay)}
                      onChange={(v) => update.mutate({ review: { newPerDay: Number(v) } })}
                      options={['10', '20', '30', '50'].map((v) => ({ value: v, label: v }))}
                    />
                  </Row>
                  <Row label={t('review.retention')} desc={t('review.retentionDesc')}>
                    <Segmented<string>
                      value={String(Math.round(s.review.retention * 100))}
                      onChange={(v) => update.mutate({ review: { retention: Number(v) / 100 } })}
                      options={['85', '90', '95'].map((v) => ({ value: v, label: `${v}%` }))}
                    />
                  </Row>
                  <h3 className="pt-6 font-serif text-md font-semibold text-fg">{t('reflect.settingsTitle')}</h3>
                  <Row label={t('reflect.daily')} desc={t('reflect.dailyDesc')}>
                    <Switch
                      checked={s.reflection.daily}
                      aria-label={t('reflect.daily')}
                      onCheckedChange={(daily) => update.mutate({ reflection: { daily } })}
                    />
                  </Row>
                  <Row label={t('reflect.weekly')} desc={t('reflect.weeklyDesc')}>
                    <Switch
                      checked={s.reflection.weekly}
                      aria-label={t('reflect.weekly')}
                      onCheckedChange={(weekly) => update.mutate({ reflection: { weekly } })}
                    />
                  </Row>
                  <Row label={t('reflect.weekday')}>
                    <Segmented<string>
                      value={String(s.reflection.weeklyDay)}
                      onChange={(v) => update.mutate({ reflection: { weeklyDay: Number(v) } })}
                      options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({
                        value: String(d),
                        label: (t('reflect.weekdays', { returnObjects: true }) as string[])[d]
                      }))}
                    />
                  </Row>
                  <Row label={t('reflect.time')}>
                    <Input
                      type="time"
                      value={s.reflection.time}
                      aria-label={t('reflect.time')}
                      onChange={(e) => e.target.value && update.mutate({ reflection: { time: e.target.value } })}
                      className="h-8 rounded-lg border border-border bg-surface px-2.5 text-sm text-fg outline-none focus:border-accent"
                    />
                  </Row>
                </>
              )}
              {tab === 'ai' && (
                <>
                  <AiSettingsTab />
                  <h3 className="pt-6 font-serif text-md font-semibold">{t('inbox.settings')}</h3>
                  <CaptureSettings settings={s.capture} save={(capture) => update.mutate({ capture })} />
                  <Row label={t('inbox.daily')}>
                    <Switch
                      checked={s.capture.daily}
                      aria-label={t('inbox.daily')}
                      onCheckedChange={(daily) => update.mutate({ capture: { daily } })}
                    />
                  </Row>
                  <Row label={t('inbox.time')}>
                    <Input
                      type="time"
                      aria-label={t('inbox.time')}
                      value={s.capture.time}
                      onChange={(e) => e.target.value && update.mutate({ capture: { time: e.target.value } })}
                      className="rounded-lg border border-border bg-surface p-2"
                    />
                  </Row>
                  {s.ai.chat.model?.toLowerCase().includes('deepseek') && (
                    <Row label={t('inbox.offPeak')}>
                      <Switch
                        checked={s.capture.offPeak}
                        aria-label={t('inbox.offPeak')}
                        onCheckedChange={(offPeak) => update.mutate({ capture: { offPeak } })}
                      />
                    </Row>
                  )}
                </>
              )}
              {tab === 'me' && <MemorySettingsTab />}
              {tab === 'skills' && <SkillsSettingsTab />}
              {tab === 'lenses' && <LensSettings />}
              {tab === 'usage' && <UsageSettings />}
              {tab === 'connections' && <ConnectionsSettings />}
              {tab === 'data' && info && <DataTab />}
              {tab === 'about' && <AboutSettings />}
            </fieldset>
          </TabsContent>
        </Tabs>
        <DialogClose asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t('common.close')} className="absolute top-4 right-4 text-subtle">
            <X className="size-4" />
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  )
}
