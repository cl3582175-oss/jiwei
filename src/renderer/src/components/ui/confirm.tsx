import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertDialog as A } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { Button } from './button'
import { Input } from './primitives'

interface ConfirmOptions {
  title: ReactNode
  description?: ReactNode
  confirmText?: string
  danger?: boolean
}

interface PromptOptions {
  title: ReactNode
  placeholder?: string
  defaultValue?: string
  confirmText?: string
}

type Request =
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOptions)

const useDialogs = create<{ req: Request | null; set: (r: Request | null) => void }>((set) => ({
  req: null,
  set: (req) => set({ req })
}))

/** 命令式确认框：if (await confirm({...})) doIt() */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().set({ kind: 'confirm', resolve, ...opts }))
}

/** 命令式输入框：返回输入内容，取消返回 null */
export function prompt(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().set({ kind: 'prompt', resolve, ...opts }))
}

export function DialogHost() {
  const { t } = useTranslation()
  const { req, set } = useDialogs()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (req?.kind === 'prompt') setValue(req.defaultValue ?? '')
  }, [req])

  const close = (result: boolean): void => {
    if (!req) return
    if (req.kind === 'confirm') req.resolve(result)
    else req.resolve(result && value.trim() ? value.trim() : null)
    set(null)
  }

  return (
    <A.Root open={!!req} onOpenChange={(o) => !o && close(false)}>
      <A.Portal>
        <A.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
        <A.Content
          className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-float outline-none data-[state=open]:animate-[dialog-in_200ms_cubic-bezier(0.2,0.9,0.3,1)]"
          onOpenAutoFocus={(e) => {
            if (req?.kind === 'prompt') {
              e.preventDefault()
              setTimeout(() => inputRef.current?.select(), 0)
            }
          }}
        >
          {req && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                close(true)
              }}
            >
              <A.Title className="text-md font-semibold text-fg">{req.title}</A.Title>
              {req.kind === 'confirm' && req.description ? (
                <A.Description className="mt-1.5 text-sm leading-relaxed text-muted">{req.description}</A.Description>
              ) : (
                <A.Description className="sr-only">{req.title}</A.Description>
              )}
              {req.kind === 'prompt' && (
                <Input
                  ref={inputRef}
                  className="mt-4"
                  value={value}
                  placeholder={req.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
              <div className="mt-6 flex justify-end gap-2">
                <A.Cancel asChild>
                  <Button variant="ghost">{t('common.cancel')}</Button>
                </A.Cancel>
                <Button
                  type="submit"
                  variant={req.kind === 'confirm' && req.danger ? 'danger' : 'primary'}
                  disabled={req.kind === 'prompt' && !value.trim()}
                >
                  {req.confirmText ?? t('common.confirm')}
                </Button>
              </div>
            </form>
          )}
        </A.Content>
      </A.Portal>
    </A.Root>
  )
}
