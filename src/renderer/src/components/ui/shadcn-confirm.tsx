import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './alert-dialog'
import { Input } from './input'
import { Alert, AlertDescription, AlertTitle } from './alert'
import { confirmMessages } from './confirmMessages'
import { createConfirmQueue, createDialogScope, type ConfirmOptions, type DialogRequest, type PromptOptions } from './confirmQueue'

export { withActionLock } from './confirmQueue'
export type { ConfirmOptions, PromptOptions } from './confirmQueue'

const dialogs = createConfirmQueue()

/** Imperative confirmation: cancellation never authorizes its caller's mutation. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return dialogs.confirm(options)
}

/** Imperative text entry: approved text is trimmed; cancellation returns null. */
export function prompt(options: PromptOptions): Promise<string | null> {
  return dialogs.prompt(options)
}

/** Bind pending dialogs to an entity/page, including scope changes and unmount. */
export function useConfirmSignal(scopeKey: string | number | null | undefined): AbortSignal {
  // The key defines the lifetime; a new key must allocate a separate signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scope = useMemo(() => createDialogScope(), [scopeKey])
  useEffect(() => scope.attach(), [scope])
  return scope.signal
}

interface FocusOrigin {
  trigger: HTMLElement | null
  workspace: HTMLElement | null
}

function canRestoreFocus(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
    !element.matches(':disabled') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden'
  )
}

function restoreFocus(origin: FocusOrigin | null): void {
  if (origin?.trigger && canRestoreFocus(origin.trigger)) {
    origin.trigger.focus({ preventScroll: true })
    if (document.activeElement === origin.trigger) return
  }
  const workspace = origin?.workspace?.isConnected ? origin.workspace : document.querySelector<HTMLElement>('main, [role="main"]')
  const target = Array.from(
    workspace?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  ).find(canRestoreFocus)
  target?.focus({ preventScroll: true })
}

function RequestDialog({ request, focusOrigin }: { request: DialogRequest; focusOrigin: RefObject<FocusOrigin | null> }) {
  const { t, i18n } = useTranslation()
  const messages = confirmMessages(i18n.language)
  const [value, setValue] = useState(request.kind === 'prompt' ? (request.defaultValue ?? '') : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const composing = useRef(false)
  const busy = request.submitting === true
  const approve = (): void => {
    if (!composing.current) dialogs.accept(request.id, value)
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) dialogs.cancel(request.id)
      }}
    >
      <AlertDialogContent
        className="block w-[min(92vw,400px)] max-w-none p-6 sm:max-w-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (!focusOrigin.current) {
            const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
            focusOrigin.current = {
              trigger,
              workspace: trigger?.closest<HTMLElement>('[role="dialog"], [data-workspace], main, [role="main"]') ?? null
            }
          }
          if (request.kind === 'prompt') {
            inputRef.current?.focus({ preventScroll: true })
            inputRef.current?.select()
          } else {
            cancelRef.current?.focus({ preventScroll: true })
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // FIFO transitions retain the initial entry point instead of trying to
          // focus the just-unmounted preceding dialog.
          if (dialogs.getSnapshot()) return
          restoreFocus(focusOrigin.current)
          focusOrigin.current = null
        }}
        onEscapeKeyDown={(event) => {
          // The active Radix layer owns this Escape; a containing workspace or
          // Dialog must not treat the same key as another close/navigation.
          event.stopPropagation()
          if (busy) event.preventDefault()
        }}
      >
        <form
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault()
            approve()
          }}
          onKeyDownCapture={(event) => {
            if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
              event.preventDefault()
              event.stopPropagation()
            }
          }}
        >
          <AlertDialogHeader className="items-start text-left sm:place-items-start">
            <AlertDialogTitle className="pr-6 text-md font-semibold">{request.title}</AlertDialogTitle>
            <AlertDialogDescription className={request.description ? 'mt-1.5 text-sm leading-relaxed' : 'sr-only'}>
              {request.description ?? request.title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {request.kind === 'prompt' && (
            <Input
              ref={inputRef}
              aria-label={typeof request.title === 'string' ? request.title : (request.placeholder ?? t('common.edit'))}
              className="mt-4"
              value={value}
              disabled={busy}
              aria-invalid={request.error !== undefined}
              aria-describedby={request.error !== undefined ? `confirm-error-${request.id}` : undefined}
              placeholder={request.placeholder}
              onChange={(event) => setValue(event.target.value)}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={() => {
                composing.current = false
              }}
            />
          )}
          {request.error !== undefined && (
            <Alert variant="destructive" id={`confirm-error-${request.id}`} className="mt-4">
              <AlertTitle>{messages.failed}</AlertTitle>
              <AlertDescription>
                <p>{request.error instanceof Error ? request.error.message : String(request.error)}</p>
                <p>{messages.retained}</p>
              </AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter className="m-0 mt-6 flex-row border-0 bg-transparent p-0">
            <AlertDialogCancel
              type="button"
              ref={cancelRef}
              variant="ghost"
              size="md"
              disabled={busy}
              onClick={() => dialogs.cancel(request.id)}
            >
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              variant={request.danger ? 'danger' : 'primary'}
              size="md"
              disabled={busy || (request.kind === 'prompt' && !value.trim())}
              onClick={(event) => {
                // Radix Action normally closes immediately. The queue owns
                // settlement, including empty/IME validation and stale clicks.
                event.preventDefault()
                approve()
              }}
            >
              {busy ? messages.working : request.error !== undefined ? messages.retry : (request.confirmText ?? t('common.confirm'))}
            </AlertDialogAction>
          </AlertDialogFooter>
          <AlertDialogCancel
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            aria-label={t('common.close')}
            disabled={busy}
            onClick={() => dialogs.cancel(request.id)}
          >
            <XIcon aria-hidden="true" />
          </AlertDialogCancel>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function DialogHost() {
  const request = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot, dialogs.getSnapshot)
  const focusOrigin = useRef<FocusOrigin | null>(null)
  useEffect(() => dialogs.attachHost(), [])
  return request ? <RequestDialog key={request.id} request={request} focusOrigin={focusOrigin} /> : null
}
