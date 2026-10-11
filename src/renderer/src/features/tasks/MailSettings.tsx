import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { MAIL_PRESETS, type MailAccount, type MailInput } from '@shared/mail'
import { api } from '@/lib/utils'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { confirm } from '@/components/ui/confirm'
const field = 'mt-1 w-full min-w-0 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-fg'
export function MailSettings() {
  const { t } = useTranslation(),
    qc = useQueryClient()
  const { data: accounts = [] } = useQuery({ queryKey: ['mail-accounts'], queryFn: () => api.mail.accounts() })
  const [editing, setEditing] = useState<MailInput | null>(null),
    [busy, setBusy] = useState(false)
  useEffect(
    () =>
      window.jiweiEvents.on('mail:changed', () => {
        void qc.invalidateQueries({ queryKey: ['mail-accounts'] })
      }),
    [qc]
  )
  const save = async () => {
    if (!editing) return
    setBusy(true)
    try {
      await api.mail.save(editing)
      setEditing(null)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  const test = async (id: string) => {
    setBusy(true)
    try {
      const r = await api.mail.test(id)
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
    } catch {
      toast.error(t('mail.unset'))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (a: MailAccount) => {
    if (await confirm({ title: t('mail.remove'), description: a.name, danger: true })) await api.mail.remove(a.id)
  }
  return (
    <section className="border-b border-border py-5" data-testid="mail-settings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-fg">{t('mail.title')}</h3>
          <p className="mt-1 text-xs text-muted">{t('mail.hint')}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            setEditing({
              name: '',
              preset: 'qq',
              host: MAIL_PRESETS.qq.host,
              port: 993,
              tls: true,
              username: '',
              secret: '',
              enabled: true
            })
          }
        >
          <Plus />
          {t('mail.add')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">{t('mail.outlook')}</p>
      {editing && (
        <div className="mt-4 space-y-3 rounded-xl border border-border bg-sunken/50 p-3" data-testid="mail-form">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted">
              {t('mail.name')}
              <input
                className={field}
                aria-label={t('mail.name')}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label className="text-xs text-muted">
              {t('mail.preset')}
              <select
                className={field}
                aria-label={t('mail.preset')}
                value={editing.preset}
                onChange={(e) => {
                  const preset = e.target.value as MailInput['preset']
                  setEditing({ ...editing, preset, host: preset === 'custom' ? '' : MAIL_PRESETS[preset].host, port: 993, tls: true })
                }}
              >
                {[...Object.keys(MAIL_PRESETS), 'custom'].map((p) => (
                  <option key={p} value={p}>
                    {p === 'custom' ? t('mail.custom') : p.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {editing.preset === 'custom' && (
            <>
              <div className="grid grid-cols-[1fr_90px] gap-3">
                <label className="text-xs text-muted">
                  {t('mail.host')}
                  <input className={field} value={editing.host} onChange={(e) => setEditing({ ...editing, host: e.target.value })} />
                </label>
                <label className="text-xs text-muted">
                  {t('mail.port')}
                  <input
                    className={field}
                    type="number"
                    value={editing.port}
                    onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs text-fg">
                <input type="checkbox" checked={editing.tls ?? true} onChange={(e) => setEditing({ ...editing, tls: e.target.checked })} />
                {t('mail.tls')}
              </label>
            </>
          )}
          <label className="block text-xs text-muted">
            {t('mail.username')}
            <input
              className={field}
              aria-label={t('mail.username')}
              value={editing.username}
              onChange={(e) => setEditing({ ...editing, username: e.target.value })}
            />
          </label>
          <label className="block text-xs text-muted">
            {t('mail.secret')}
            <input
              className={field}
              aria-label={t('mail.secret')}
              type="password"
              autoComplete="new-password"
              value={editing.secret ?? ''}
              placeholder={editing.id ? t('mail.saved') : t('mail.unset')}
              onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
            />
          </label>
          {editing.preset !== 'custom' && (
            <button
              className="text-xs text-accent hover:underline"
            onClick={() => void api.mail.help(editing.preset as keyof typeof MAIL_PRESETS)}
            >
              {t('mail.help')}
            </button>
          )}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={busy || !editing.name.trim() || !editing.username.trim() || (!editing.id && !editing.secret)}
              variant="primary"
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
      <div className="mt-3 space-y-3">
        {accounts.map((a) => (
          <article key={a.id} className="rounded-xl border border-border p-3" data-mail-id={a.id}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-fg">{a.name}</p>
                <p className="truncate text-xs text-muted">
                  {a.username} · {a.secretSet ? t('mail.saved').split('（')[0].split('(')[0] : t('mail.unset')}
                </p>
              </div>
              <Switch
                checked={a.enabled}
                aria-label={t('mail.enabled')}
                onCheckedChange={(enabled) => void api.mail.save({ ...a, enabled })}
              />
            </div>
            {a.lastError && <p className="mt-2 text-xs text-danger">{a.lastError}</p>}
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={busy || !a.enabled} onClick={() => void test(a.id)}>
                {t('mail.test')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setEditing({ ...a, secret: '' })}>
                {t('common.edit')}
              </Button>
              <Button size="sm" disabled={busy} variant="ghost" onClick={() => void remove(a)}>
                {t('common.delete')}
              </Button>
            </div>
          </article>
        ))}
        {!accounts.length && <p className="text-xs text-muted">{t('mail.empty')}</p>}
      </div>
    </section>
  )
}
