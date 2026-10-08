import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Pin, PinOff, Pencil, Trash2, Plus, Sparkles, UserRound, ShieldAlert, Check, X } from 'lucide-react'
import { PROFILE_KEYS, type Memory, type MemoryKind, type ProfileKey } from '@shared/types'
import { useMemories, useUserProfile } from '@/lib/queries'
import { api, cn, formatRelative } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { confirm, prompt } from '@/components/ui/confirm'

// 「关于我」：个人档案（用户预设）+ 积微记住的内容（可查看、编辑、钉住、删除）。

const LIST_KINDS: MemoryKind[] = ['preference', 'fact', 'glossary', 'skill']

function ProfileField({ k, value }: { k: ProfileKey; value: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  return (
    <label className="block">
      <span className="text-xs font-medium text-fg">{t(`memory.profile.${k}`)}</span>
      <textarea
        key={value}
        defaultValue={value}
        rows={k === 'role' ? 1 : 2}
        placeholder={t(`memory.profile.${k}Ph`)}
        aria-label={t(`memory.profile.${k}`)}
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (v === value) return
          void api.memory.setProfile({ [k]: v }).then(() => {
            void qc.invalidateQueries({ queryKey: ['userProfile'] })
            toast.success(t('memory.saved'))
          })
        }}
        className="mt-1.5 block w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-fg outline-none placeholder:text-subtle focus:border-accent"
      />
    </label>
  )
}

function MemoryRow({ m }: { m: Memory }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['memories'] })
  const edit = async (): Promise<void> => {
    const v = await prompt({ title: t('memory.edit'), defaultValue: m.content, confirmText: t('common.save') })
    if (v?.trim() && v.trim() !== m.content) await api.memory.save({ id: m.id, kind: m.kind, content: v.trim() })
    refresh()
  }
  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: t('memory.removeTitle'), description: m.content, confirmText: t('common.delete'), danger: true }))) return
    await api.memory.remove(m.id)
    refresh()
  }
  return (
    <li
      className={cn(
        'group flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-hover',
        m.status === 'pending' && 'bg-accent-soft/40'
      )}
    >
      <span className="mt-0.5 shrink-0 text-subtle [&_svg]:size-3.5">
        {m.status === 'pending' ? <ShieldAlert className="text-[#b8862b]" /> : m.origin === 'ai' ? <Sparkles /> : <UserRound />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-fg">{m.content}</p>
        <p className="mt-0.5 text-2xs text-subtle">
          {m.status === 'pending' ? t('memory.pending') : m.origin === 'ai' ? t('memory.byAi') : t('memory.byYou')}
          {m.skill && ` · ${m.skill}`} · {formatRelative(m.updatedAt, i18n.language)}
          {m.useCount > 0 && ` · ${t('memory.used', { count: m.useCount })}`}
        </p>
      </div>
      {m.status === 'pending' ? (
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="primary" onClick={() => void api.memory.confirm(m.id).then(refresh)}>
            <Check />
            {t('memory.confirm')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void api.memory.remove(m.id).then(refresh)}>
            <X />
            {t('memory.dismiss')}
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Tip label={m.pinned ? t('memory.unpin') : t('memory.pin')}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.pinned ? t('memory.unpin') : t('memory.pin')}
              onClick={() => void api.memory.save({ id: m.id, kind: m.kind, content: m.content, pinned: !m.pinned }).then(refresh)}
            >
              {m.pinned ? <PinOff /> : <Pin />}
            </Button>
          </Tip>
          <Tip label={t('memory.edit')}>
            <Button size="icon-sm" variant="ghost" aria-label={t('memory.edit')} onClick={() => void edit()}>
              <Pencil />
            </Button>
          </Tip>
          <Tip label={t('common.delete')}>
            <Button size="icon-sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove()}>
              <Trash2 />
            </Button>
          </Tip>
        </div>
      )}
      {m.pinned && m.status !== 'pending' && <Pin className="mt-1 size-3 shrink-0 text-accent group-hover:hidden" />}
    </li>
  )
}

export function MemorySettingsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: profile } = useUserProfile()
  const { data: list = [] } = useMemories()
  const [kind, setKind] = useState<MemoryKind | 'all'>('all')
  const shown = list.filter((m) => m.kind !== 'profile' && (kind === 'all' || m.kind === kind))
  const pending = shown.filter((m) => m.status === 'pending')
  const active = shown.filter((m) => m.status !== 'pending')

  const add = async (): Promise<void> => {
    const v = await prompt({ title: t('memory.addTitle'), placeholder: t('memory.addPh'), confirmText: t('common.save') })
    if (!v?.trim()) return
    await api.memory.save({ kind: kind === 'all' ? 'preference' : kind, content: v.trim() })
    void qc.invalidateQueries({ queryKey: ['memories'] })
  }

  return (
    <div className="py-4">
      <section>
        <h3 className="font-serif text-md font-semibold text-fg">{t('memory.profileTitle')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">{t('memory.profileDesc')}</p>
        {profile && (
          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4">
            {PROFILE_KEYS.map((k) => (
              <div key={k} className={cn(k === 'role' || k === 'avoid' ? 'col-span-2' : '')}>
                <ProfileField k={k} value={profile[k] ?? ''} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-serif text-md font-semibold text-fg">{t('memory.listTitle')}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t('memory.listDesc')}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void add()}>
            <Plus />
            {t('memory.add')}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(['all', ...LIST_KINDS] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                kind === k ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg'
              )}
            >
              {t(`memory.kinds.${k}`)}
            </button>
          ))}
        </div>
        {pending.length + active.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs leading-relaxed text-muted">
            {t('memory.empty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-0.5">
            {[...pending, ...active].map((m) => (
              <MemoryRow key={m.id} m={m} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
