import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Cable, Check, ExternalLink, LogIn, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip } from '@/components/ui/primitives'
import { api, cn } from '@/lib/utils'
import { websiteDomain } from '@shared/browserSafety'
import type { BrowserTab } from '@shared/types'
import { safetyMessage } from '../settings/SafetyProgress'
import { useGoogleLogin } from './useGoogleLogin'

export function LoginSafetyBar({ tab }: { tab: BrowserTab }) {
  const { t } = useTranslation()
  const blocked = tab.loginBlocked
  const google = useGoogleLogin()
  const isGoogle = blocked?.reason === 'google' && !tab.incognito
  if (!blocked && !tab.externalNotice) return null
  return (
    <div
      className="safety-ui flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/25 bg-warning/10 px-4 py-2.5 text-sm leading-relaxed"
      data-testid="browser-login-warning"
    >
      <p className="min-w-0 flex-[1_1_16rem] text-fg">
        {isGoogle && google.busy
          ? t(google.status === 'injecting' ? 'safety.browser.googleInjecting' : 'safety.browser.googleWaiting')
          : t(blocked ? (isGoogle ? 'safety.browser.googleBlocked' : blocked.reason === 'google' ? 'safety.browser.google' : 'safety.browser.youtube') : 'safety.browser.opened')}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {blocked ? (
          <>
            {isGoogle && (
              <Button
                size="sm"
                variant="primary"
                disabled={google.busy && google.status === 'injecting'}
                onClick={google.busy ? google.cancel : google.start}
                data-testid="google-login-button"
              >
                <LogIn />
                {t(google.busy ? 'safety.browser.googleCancel' : 'safety.browser.googleLogin')}
              </Button>
            )}
            <Button size="sm" variant={isGoogle ? 'ghost' : 'primary'} onClick={() => void api.browser.openExternal(tab.id).catch((e) => toast.error(safetyMessage(e)))}>
              <ExternalLink />
              {t('safety.browser.openExternal')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-auto min-h-8 py-1.5 text-left whitespace-normal"
              onClick={() =>
                void api.browser
                  .externalSite(websiteDomain(blocked.url), true)
                  .then(() => api.browser.openExternal(tab.id))
                  .catch((e) => toast.error(safetyMessage(e)))
              }
            >
              {t('safety.browser.always')}
            </Button>
            <Tip label={t('safety.browser.close')}>
              <Button size="icon-sm" variant="ghost" aria-label={t('safety.browser.close')} onClick={() => void api.browser.dismissLogin(tab.id)}>
                <X />
              </Button>
            </Tip>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-auto min-h-8 py-1.5 text-left whitespace-normal"
            onClick={() => void api.browser.externalSite(tab.externalNotice!.site, false)}
          >
            {t('safety.browser.undo')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** 地址栏里的小图标菜单：这个网站跟随系统、直连还是走代理。有规则时图标高亮。 */
export function WebsiteNetwork({ tab }: { tab: BrowserTab }) {
  const { t } = useTranslation()
  const { data, refetch } = useQuery({ queryKey: ['browser-network'], queryFn: () => api.browser.networkStatus() })
  if (!/^https?:/.test(tab.url)) return null
  const domain = websiteDomain(tab.url),
    rule = data?.rules.find((r) => r.domain === domain),
    current = rule?.mode ?? 'system'
  const choose = (mode: 'system' | 'direct' | 'proxy'): void => {
    if (mode === current) return
    void api.browser
      .networkRules([...(data?.rules ?? []).filter((r) => r.domain !== domain), ...(mode === 'system' ? [] : [{ domain, mode }])])
      .then(async () => {
        await refetch()
        await api.browser.command(tab.id, 'reload')
      })
      .catch((e) => toast.error(safetyMessage(e)))
  }
  const options = [
    { mode: 'system' as const, label: t('safety.browser.system') },
    { mode: 'direct' as const, label: t('safety.browser.direct') },
    { mode: 'proxy' as const, label: t(data?.proxyAvailable ? 'safety.browser.proxy' : 'safety.browser.proxyOff'), disabled: !data?.proxyAvailable }
  ]
  return (
    <Menu>
      <Tip label={t('safety.browser.siteNetworkHint', { domain })} side="bottom">
        <MenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('size-7 shrink-0', rule && 'bg-accent-soft text-accent')}
            aria-label={t('safety.browser.siteNetwork')}
            data-testid="website-network"
          >
            <Cable />
          </Button>
        </MenuTrigger>
      </Tip>
      <MenuContent align="end">
        <MenuLabel>{domain}</MenuLabel>
        {options.map((o) => (
          <MenuItem key={o.mode} disabled={o.disabled} onSelect={() => choose(o.mode)}>
            {current === o.mode ? <Check /> : <span className="size-4" />}
            {o.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
