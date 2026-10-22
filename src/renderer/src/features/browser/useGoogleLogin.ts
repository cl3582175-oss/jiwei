import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/utils'
import type { GoogleLoginInfo } from '@shared/types'

/** 借 Chrome 登录 Google：状态来自主进程事件，登录结果用提示告知 */
export function useGoogleLogin() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['google-login'], queryFn: () => api.browser.googleLoginStatus() })
  useEffect(
    () =>
      window.jiweiEvents.on('browser:google-login', (state) => {
        qc.setQueryData<GoogleLoginInfo>(['google-login'], (old) => ({ loggedIn: old?.loggedIn ?? false, state }))
        if (state.status === 'done') toast.success(t('safety.browser.googleDone'))
        else if (state.status === 'failed' && state.reason !== 'cancelled') toast.error(state.message ?? '')
        if (state.status === 'done' || state.status === 'failed' || state.status === 'idle')
          void qc.invalidateQueries({ queryKey: ['google-login'] })
      }),
    [qc, t]
  )
  const status = data?.state.status ?? 'idle'
  return {
    loggedIn: !!data?.loggedIn,
    busy: status === 'waiting' || status === 'injecting',
    status,
    start: () => void api.browser.googleLoginStart(),
    cancel: () => void api.browser.googleLoginCancel(),
    logout: async () => {
      await api.browser.googleLogout()
      await qc.invalidateQueries({ queryKey: ['google-login'] })
      toast.success(t('safety.browser.googleLoggedOut'))
    }
  }
}
