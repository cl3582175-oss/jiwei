import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, LogIn } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { useSettings } from '@/lib/queries'
import { safetyMessage } from './SafetyProgress'
import { DomainSchema } from '@shared/browserSafety'
import { useGoogleLogin } from '../browser/useGoogleLogin'

export function BrowserSafetySettings() {
  const { t } = useTranslation()
  const qc = useQueryClient(),
    [domain, setDomain] = useState(''),
    [mode, setMode] = useState<'direct' | 'proxy'>('direct'),
    [busy, setBusy] = useState(false),
    { data: settings } = useSettings(),
    google = useGoogleLogin()
  const { data: network } = useQuery({ queryKey: ['browser-network'], queryFn: () => api.browser.networkStatus() })
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      void qc.invalidateQueries({ queryKey: ['browser-network'] })
      void qc.invalidateQueries({ queryKey: ['settings'] })
    } catch (e) {
      toast.error(safetyMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="safety-ui space-y-5 py-5 text-sm" data-testid="browser-safety-settings">
      <div className="space-y-3 border-b border-border pb-5" data-testid="google-login-settings">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <LogIn className="size-5 text-accent" />
          {t('safety.browser.googleTitle')}
          <span className="text-xs font-normal text-muted">· {t(google.loggedIn ? 'safety.browser.googleOn' : 'safety.browser.googleOff')}</span>
        </h3>
        <p className="leading-relaxed text-muted">{t('safety.browser.googleDesc')}</p>
        <p className="text-xs text-muted">{t('safety.browser.googleAiNote')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={google.busy ? google.cancel : google.start} disabled={google.status === 'injecting'}>
            {t(google.busy ? 'safety.browser.googleCancel' : google.loggedIn ? 'safety.browser.googleRelogin' : 'safety.browser.googleLogin')}
          </Button>
          {google.loggedIn && !google.busy && (
            <Button variant="ghost" onClick={() => void google.logout().catch((e) => toast.error(safetyMessage(e)))}>
              {t('safety.browser.googleLogout')}
            </Button>
          )}
        </div>
        {google.busy && <p className="text-xs text-muted">{t(google.status === 'injecting' ? 'safety.browser.googleInjecting' : 'safety.browser.googleWaiting')}</p>}
      </div>
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Globe className="size-5 text-accent" />
        {t('safety.browser.networkTitle')}
      </h3>
      <p className="leading-relaxed text-muted">
        {t('safety.browser.networkDesc')}
      </p>
      <p className="text-xs text-muted">
        {t(network?.proxyAvailable ? 'safety.browser.proxyRead' : 'safety.browser.proxyMissing')}
      </p>
      <form
        className="safety-ui space-y-3 rounded-xl border border-border p-4"
        onSubmit={(e) => {
          e.preventDefault()
          const parsed = DomainSchema.safeParse(domain)
          if (!parsed.success) {
            toast.error(t('safety.browser.domainInvalid'))
            return
          }
          void act(async () => {
            await api.browser.networkRules([
              ...(network?.rules ?? []).filter((r) => r.domain !== parsed.data),
              { domain: parsed.data, mode }
            ])
            setDomain('')
          })
        }}
      >
        <label className="block space-y-2">
          <span>{t('safety.browser.domain')}</span>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={t('safety.browser.domainPlaceholder')} aria-label={t('safety.browser.domain')} />
        </label>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label={t('safety.browser.mode')}
            value={mode}
            onChange={(e) => setMode(e.target.value as 'direct' | 'proxy')}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="direct">{t('safety.browser.direct')}</option>
            <option value="proxy" disabled={!network?.proxyAvailable}>
              {t(network?.proxyAvailable ? 'safety.browser.proxy' : 'safety.browser.proxyOff')}
            </option>
          </select>
          <Button variant="primary" disabled={busy || !domain.trim()} type="submit">
            {t('safety.browser.save')}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted">{t('safety.browser.ruleHint')}</p>
      </form>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          void act(() =>
            api.browser.networkRules([
              ...(network?.rules ?? []).filter((r) => !['bilibili.com', 'bilivideo.com', 'hdslb.com'].includes(r.domain)),
              ...['bilibili.com', 'bilivideo.com', 'hdslb.com'].map((domain) => ({ domain, mode: 'direct' as const }))
            ])
          )
        }
      >
        {t('safety.browser.bilibili')}
      </Button>
      <div className="space-y-3">
        {!network?.rules.length ? (
          <p className="rounded-xl bg-sunken p-4 text-muted">{t('safety.browser.noRules')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {network.rules.map((r) => (
              <li key={r.domain} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="break-all">
                  {r.domain} · {t(r.mode === 'direct' ? 'safety.browser.direct' : 'safety.browser.proxy')}
                </span>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act(() => api.browser.networkRules(network.rules.filter((x) => x.domain !== r.domain)))}
                >
                  {t('safety.browser.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-3 border-t border-border pt-5">
        <h4 className="font-medium">{t('safety.browser.externalTitle')}</h4>
        <p className="text-xs leading-relaxed text-muted">{t('safety.browser.externalDesc')}</p>
        {settings?.browser?.externalSites?.length ? (
          <ul className="space-y-2">
            {settings.browser.externalSites.map((site) => (
              <li key={site} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <span className="break-all">{site}</span>
                <Button variant="ghost" onClick={() => void act(() => api.browser.externalSite(site, false))}>
                  {t('safety.browser.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">{t('safety.browser.noExternal')}</p>
        )}
      </div>
    </section>
  )
}
