import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog as D } from 'radix-ui'
import { motion, AnimatePresence } from 'motion/react'
import { Library, Sparkles, ShieldCheck, ArrowRight, Monitor, Sun, Moon } from 'lucide-react'
import type { Palette, ThemeMode } from '@shared/types'
import { useSettings, useUpdateSettings, invalidate } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { Logo } from '@/components/Logo'
import { InkWelcome } from '@/components/Illustrations'
import { PaletteCard, Segmented } from '../settings/SettingsDialog'
import { RoleBatchDialog, RoleGrid } from '../plugins/RolePicker'

const STEPS = 4
const ROLES = 2

/** 首次启动引导：认识积微 → 个性化 → 选角色（v0.10）→ 康奈尔笔记法（创建示例笔记） */
export function Onboarding() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: () => api.profile.get() })
  const [step, setStep] = useState(0)
  const [name, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [roles, setRoles] = useState<string[]>([]),
    [confirmRoles, setConfirmRoles] = useState(false)
  if (!s || s.onboarded) return null
  const dark = document.documentElement.dataset.theme === 'dark'

  const finish = async (withSample: boolean): Promise<void> => {
    setBusy(true)
    try {
      const n = (name ?? profile?.name ?? '').trim()
      if (n && n !== profile?.name) await api.profile.setName(n)
      if (withSample) {
        const note = await api.notes.createSample(i18n.language === 'en' ? 'en' : 'zh-CN')
        invalidate(qc, 'notes', 'heatmap')
        useApp.getState().openNote(note.id)
      }
      update.mutate({ onboarded: true })
    } finally {
      setBusy(false)
    }
  }

  const pillars = [
    { icon: <Library />, tint: 'bamboo', title: t('onboarding.p1'), desc: t('onboarding.p1d') },
    { icon: <Sparkles />, tint: 'sky', title: t('onboarding.p2'), desc: t('onboarding.p2d') },
    { icon: <ShieldCheck />, tint: 'apricot', title: t('onboarding.p3'), desc: t('onboarding.p3d') }
  ]

  return (
    <D.Root open>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[var(--desk)]/70 backdrop-blur-md" />
        <D.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="paper fixed top-1/2 left-1/2 z-50 flex h-[min(90vh,560px)] w-[min(94vw,906px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl shadow-[var(--shadow-4)] outline-none"
        >
          <D.Title className="sr-only">{t('onboarding.dialogTitle')}</D.Title>
          <D.Description className="sr-only">{t('app.slogan')}</D.Description>
          <button onClick={() => void finish(false)} className="absolute top-5 right-6 z-10 text-xs text-subtle hover:text-fg">
            {t('onboarding.skip')}
          </button>

          <div className="relative min-h-0 flex-1">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -24 }}
                transition={{ duration: 0.28, ease: [0.2, 0.9, 0.3, 1] }}
                className="absolute inset-0 flex flex-col px-14 pt-12"
              >
                {step === 0 && (
                  <>
                    <div className="flex items-center gap-4">
                      <Logo size={48} />
                      <div>
                        <h2 className="font-display text-xl font-semibold tracking-[0.08em] text-fg">{t('onboarding.title')}</h2>
                        <p className="mt-1 font-kai text-md text-muted">{t('app.slogan')}</p>
                      </div>
                    </div>
                    <p className="mt-6 max-w-[560px] text-sm leading-relaxed text-muted">{t('onboarding.intro')}</p>
                    <div className="mt-8 grid grid-cols-3 gap-4">
                      {pillars.map((p) => (
                        <div key={p.title} className="rounded-2xl bg-surface p-5 shadow-[var(--shadow-1)]">
                          <div data-tint={p.tint} className="tint grid size-10 place-items-center rounded-xl [&_svg]:size-[18px]">
                            {p.icon}
                          </div>
                          <p className="mt-4 font-display text-md font-semibold text-fg">{p.title}</p>
                          <p className="mt-1.5 text-xs leading-relaxed text-muted">{p.desc}</p>
                        </div>
                      ))}
                    </div>
                    <InkWelcome
                      size={906}
                      preserveAspectRatio="xMidYMax slice"
                      className="pointer-events-none absolute right-0 -bottom-20 left-0 -z-10 h-[230px] w-full text-subtle opacity-60"
                    />
                  </>
                )}

                {step === 1 && (
                  <>
                    <h2 className="font-display text-xl font-semibold tracking-[0.06em] text-fg">{t('onboarding.personalize')}</h2>
                    <p className="mt-2 text-sm text-muted">{t('onboarding.personalizeDesc')}</p>
                    <label className="mt-8 block max-w-[320px]">
                      <span className="mb-2 block text-xs text-muted">{t('profile.name')}</span>
                      <Input
                        value={name ?? profile?.name ?? ''}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('onboarding.namePlaceholder')}
                      />
                    </label>
                    <div className="mt-8">
                      <span className="mb-3 block text-xs text-muted">{t('settings.palette')}</span>
                      <div className="flex gap-4">
                        {(['qinglu', 'celadon', 'dunhuang'] as Palette[]).map((id) => (
                          <PaletteCard
                            key={id}
                            id={id}
                            dark={dark}
                            active={s.palette === id}
                            onPick={() => update.mutate({ palette: id })}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="mt-8">
                      <span className="mb-3 block text-xs text-muted">{t('settings.theme')}</span>
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
                    </div>
                  </>
                )}

                {step === ROLES && (
                  <>
                    <h2 className="font-display text-xl font-semibold tracking-[0.06em] text-fg">{t('onboarding.roles')}</h2>
                    <p className="mt-2 max-w-[640px] text-sm leading-relaxed text-muted">{t('onboarding.rolesDesc')}</p>
                    <div className="-mx-2 mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                      <RoleGrid
                        selected={roles}
                        onToggle={(id) => setRoles((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]))}
                      />
                    </div>
                  </>
                )}

                {step === 3 && (
                  <>
                    <h2 className="font-display text-xl font-semibold tracking-[0.06em] text-fg">{t('onboarding.cornell')}</h2>
                    <p className="mt-2 max-w-[600px] text-sm leading-relaxed text-muted">{t('onboarding.cornellDesc')}</p>
                    {/* 康奈尔版面示意：线索 0.382 | 笔记 0.618，底部总结 */}
                    <div className="cornell-card mt-8 overflow-hidden">
                      <div className="grid grid-cols-[38.2fr_61.8fr]">
                        <div className="border-r border-border p-5">
                          <p className="text-2xs tracking-[0.18em] text-subtle">{t('notes.cue')}</p>
                          <p className="mt-2 font-kai text-md text-fg">{t('onboarding.cueEx')}</p>
                          <p className="mt-3 text-xs leading-relaxed text-muted">{t('onboarding.cueHow')}</p>
                        </div>
                        <div className="p-5">
                          <p className="text-2xs tracking-[0.18em] text-subtle">{t('notes.content')}</p>
                          <p className="mt-2 text-sm text-fg">{t('onboarding.bodyEx')}</p>
                          <p className="mt-3 text-xs leading-relaxed text-muted">{t('onboarding.bodyHow')}</p>
                        </div>
                      </div>
                      <div className="border-t border-border bg-sunken/40 px-5 py-4">
                        <p className="text-2xs tracking-[0.18em] text-subtle">{t('notes.summary')}</p>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted">{t('onboarding.summaryHow')}</p>
                      </div>
                    </div>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="flex h-20 shrink-0 items-center justify-between px-14">
            <div className="flex gap-1.5">
              {Array.from({ length: STEPS }, (_, i) => (
                <span
                  key={i}
                  className={cn('h-1.5 rounded-full transition-all duration-300', i === step ? 'w-6 bg-accent' : 'w-1.5 bg-border-strong')}
                />
              ))}
            </div>
            <div className="flex gap-2">
              {step > 0 && (
                <Button variant="ghost" onClick={() => setStep(step - 1)}>
                  {t('onboarding.back')}
                </Button>
              )}
              {step === ROLES ? (
                <Button variant="primary" onClick={() => (roles.length ? setConfirmRoles(true) : setStep(step + 1))}>
                  {roles.length ? t('onboarding.installRoles', { count: roles.length }) : t('onboarding.skipRoles')}
                  <ArrowRight />
                </Button>
              ) : step < STEPS - 1 ? (
                <Button variant="primary" onClick={() => setStep(step + 1)}>
                  {step === 0 ? t('onboarding.start') : t('onboarding.next')}
                  <ArrowRight />
                </Button>
              ) : (
                <>
                  <Button variant="ghost" disabled={busy} onClick={() => void finish(false)}>
                    {t('onboarding.blank')}
                  </Button>
                  <Button variant="primary" disabled={busy} onClick={() => void finish(true)}>
                    {t('onboarding.openSample')}
                    <ArrowRight />
                  </Button>
                </>
              )}
            </div>
          </footer>
        </D.Content>
      </D.Portal>
      {confirmRoles && (
        <RoleBatchDialog
          ids={roles}
          onClose={() => setConfirmRoles(false)}
          onDone={() => {
            setConfirmRoles(false)
            setRoles([])
            setStep(ROLES + 1)
          }}
        />
      )}
    </D.Root>
  )
}
