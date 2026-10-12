import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bot, Check, ChevronDown, Feather, MessageSquare, Scale, X } from 'lucide-react'
import type { RoleStarters } from '@shared/plugins'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import type { Tint } from '@/lib/tint'
import { pluginError } from './PluginConfirmDialog'
import { runStarter } from './starters'

const kindIcon = {
  chat: { icon: <MessageSquare />, tint: 'sky' as Tint },
  advisor: { icon: <Scale />, tint: 'apricot' as Tint },
  work: { icon: <Feather />, tint: 'bamboo' as Tint },
  recipe: { icon: <Bot />, tint: 'lotus' as Tint }
}

function RoleCard({ role }: { role: RoleStarters }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const zh = i18n.language.startsWith('zh')
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['plugins', 'starters'] })
    } catch (e) {
      toast.error(pluginError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="paper rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]" data-testid="role-starters" data-plugin-id={role.pluginId}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-md font-semibold text-fg">
            {t('plugins.startersTitle', { name: zh ? role.name.zh : role.name.en })}
          </h2>
          <p className="mt-1 text-xs text-muted">{t('plugins.startersHint')}</p>
        </div>
        <Tip label={t('plugins.startersDismiss')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('plugins.startersDismiss')}
            disabled={busy}
            onClick={() => void act(() => api.plugins.dismissStarters(role.pluginId))}
          >
            <X />
          </Button>
        </Tip>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 @min-[640px]:grid-cols-3">
        {role.starters.map((s) => {
          const k = kindIcon[s.action.kind]
          return (
            <button
              key={s.id}
              disabled={busy}
              data-starter-id={s.id}
              onClick={() => void act(() => runStarter(role.pluginId, s.id))}
              className={cn(
                'group flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent-soft/40',
                s.completed && 'opacity-60'
              )}
            >
              <span data-tint={k.tint} className="tint grid size-9 shrink-0 place-items-center rounded-xl [&_svg]:size-[17px]">
                {s.completed ? <Check /> : k.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{zh ? s.title.zh : s.title.en}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted">{zh ? s.body.zh : s.body.en}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** 今日页：最近安装的角色包的起步卡；其他角色收在下面，展开再看 */
export function RoleStartersCard() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [more, setMore] = useState(false)
  const { data = [] } = useQuery({ queryKey: ['plugins', 'starters'], queryFn: () => api.plugins.roleStarters() })
  useEffect(() => window.jiweiEvents.on('plugins:changed', () => void qc.invalidateQueries({ queryKey: ['plugins', 'starters'] })), [qc])
  if (!data.length) return null
  const [first, ...rest] = data
  return (
    <div className="mt-6 space-y-3">
      <RoleCard role={first} />
      {rest.length > 0 &&
        (more ? (
          rest.map((r) => <RoleCard key={r.pluginId} role={r} />)
        ) : (
          <button
            onClick={() => setMore(true)}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs text-muted hover:bg-surface-hover hover:text-fg"
          >
            <ChevronDown className="size-3.5" />
            {t('plugins.startersMore', {
              count: rest.length,
              names: rest.map((r) => (i18n.language.startsWith('zh') ? r.name.zh : r.name.en)).join('、')
            })}
          </button>
        ))}
    </div>
  )
}
