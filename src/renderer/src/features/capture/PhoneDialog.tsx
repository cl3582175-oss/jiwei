import { useEffect, useState } from 'react'
import { Dialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/utils'
import type { PhoneStatus } from '@shared/capture'
import { Button } from '@/components/ui/button'
export function requestPhoneUpload(): void {
  window.dispatchEvent(new Event('phone:open'))
}
export function PhoneDialog() {
  const { t } = useTranslation(),
    [open, setOpen] = useState(false),
    [state, setState] = useState<PhoneStatus | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    const fn = (): void => setOpen(true)
    window.addEventListener('phone:open', fn)
    return () => window.removeEventListener('phone:open', fn)
  }, [])
  useEffect(() => {
    if (!open) return
    let disposed = false,
      id: string | null = null
    setState(null)
    setError('')
    void api.phone
      .start()
      .then((s) => {
        id = s.sessionId
        if (disposed) void api.phone.stop(id)
        else setState(s)
      })
      .catch(() => setError('capture.noNetwork'))
    const timer = setInterval(() => {
      void api.phone.status().then((s) => {
        if (!disposed && (!id || s?.sessionId === id)) setState(s)
      })
    }, 700)
    return () => {
      disposed = true
      clearInterval(timer)
      if (id) void api.phone.stop(id)
    }
  }, [open])
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(90vw,420px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-border bg-surface p-6 text-fg shadow-float">
          <Dialog.Title className="text-xl">{t('capture.phone')}</Dialog.Title>
          <Dialog.Description className="my-3 text-sm">{t('capture.wifi')}</Dialog.Description>
          {state && (
            <>
              <img src={state.qr} alt={t('capture.qr')} className="mx-auto h-56 w-56" />
              <p className="my-3 break-all text-xs select-text">{state.url}</p>
              <p role="status">{state.active ? t('capture.received', { count: state.received }) : t('capture.expired')}</p>
            </>
          )}
          {error && <p role="alert">{t(error)}</p>}
          <Dialog.Close asChild>
            <Button className="mt-5">{t('capture.close')}</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
