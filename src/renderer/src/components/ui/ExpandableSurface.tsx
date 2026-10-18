import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Dialog as D } from 'radix-ui'
import { Maximize2, Minimize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ScrollAxisMemory } from './scrollMemory'

type ExitReason = 'user' | 'escape' | 'outside-action' | 'unavailable' | 'unmount' | 'error'
type Mode = 'inline' | 'opening' | 'expanded' | 'closing'
type ScrollPosition = { element: HTMLElement; top: number; left: number }
type InnerScrollMemory = Map<HTMLElement, { x: ScrollAxisMemory; y: ScrollAxisMemory }>
interface Presentation {
  expanded: boolean
  available: boolean
  open(): void
  close(reason?: ExitReason): void
  runOutside(action: () => void): void
}
const PresentationContext = createContext<Presentation>({
  expanded: false,
  available: false,
  open: () => undefined,
  close: () => undefined,
  runOutside: (action) => action()
})
export const useExpandedPresentation = (): Presentation => useContext(PresentationContext)

function restoreScroll(positions: ScrollPosition[]): void {
  for (const { element, top, left } of positions) {
    if (!element.isConnected) continue
    element.scrollTop = top
    element.scrollLeft = left
  }
}

function scrollMemory(element: HTMLElement) {
  return {
    x: new ScrollAxisMemory(element.scrollLeft, Math.max(0, element.scrollWidth - element.clientWidth)),
    y: new ScrollAxisMemory(element.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight))
  }
}

function captureInnerScroll(root: HTMLElement): InnerScrollMemory {
  const result: InnerScrollMemory = new Map()
  for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    if (!(element instanceof HTMLElement)) continue
    const style = getComputedStyle(element)
    if (
      element.classList.contains('ui-frame-body') ||
      element.scrollTop ||
      element.scrollLeft ||
      /auto|scroll/.test(style.overflowX + style.overflowY)
    )
      result.set(element, scrollMemory(element))
  }
  return result
}

function observeInnerScroll(memory: InnerScrollMemory): void {
  for (const [element, axis] of memory) {
    if (!element.isConnected) continue
    axis.x.observe(element.scrollLeft, Math.max(0, element.scrollWidth - element.clientWidth))
    axis.y.observe(element.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight))
  }
}

function restoreInnerScroll(memory: InnerScrollMemory): void {
  for (const [element, axis] of memory) {
    if (!element.isConnected) continue
    element.scrollLeft = axis.x.target
    element.scrollTop = axis.y.target
    axis.x.settle(element.scrollLeft, Math.max(0, element.scrollWidth - element.clientWidth))
    axis.y.settle(element.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight))
  }
}

/** The portal target never changes. Only its owned parent changes; children stay mounted. */
export function ExpandableSurface({
  children,
  title,
  available,
  onEscapeKeyDown
}: {
  children: ReactNode
  title: string
  available: boolean
  onEscapeKeyDown?(event: KeyboardEvent): void
}) {
  const { t } = useTranslation()
  const [mount] = useState(() => {
    const element = document.createElement('div')
    element.className = 'expanded-mount'
    element.dataset.displayMode = 'inline'
    return element
  })
  const anchor = useRef<HTMLDivElement>(null)
  const modal = useRef<HTMLDivElement | null>(null)
  const mode = useRef<Mode>('inline')
  const mounted = useRef(false)
  const reason = useRef<ExitReason>('user')
  const trigger = useRef<HTMLElement | null>(null)
  const innerScroll = useRef<InnerScrollMemory>(new Map())
  const readingScroll = useRef<ScrollPosition[]>([])
  const pendingAction = useRef<(() => void) | null>(null)
  const frames = useRef<number[]>([])
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState(false)
  const cancelFrames = useCallback(() => {
    for (const frame of frames.current) cancelAnimationFrame(frame)
    frames.current = []
  }, [])
  const settleScroll = useCallback(() => {
    cancelFrames()
    // Restore content once after reparenting; delayed restores must not undo a new user scroll.
    restoreInnerScroll(innerScroll.current)
    const restore = (): void => restoreScroll(readingScroll.current)
    restore()
    frames.current.push(
      requestAnimationFrame(() => {
        if (!mounted.current) return
        restore()
        frames.current.push(
          requestAnimationFrame(() => {
            if (mounted.current) restore()
          })
        )
      })
    )
  }, [cancelFrames])
  const returnInline = useCallback(() => {
    if (!anchor.current) return
    if (mount.parentElement !== anchor.current) anchor.current.appendChild(mount)
    mount.dataset.displayMode = 'inline'
    anchor.current.style.height = ''
    settleScroll()
  }, [mount, settleScroll])
  const close = useCallback(
    (exit: ExitReason = 'user') => {
      if (mode.current === 'inline' || mode.current === 'closing') return
      reason.current = exit
      mode.current = 'closing'
      if (mount.dataset.displayMode === 'expanded') observeInnerScroll(innerScroll.current)
      returnInline()
      setExpanded(false)
    },
    [mount, returnInline]
  )
  const open = useCallback(() => {
    if (
      !available ||
      mode.current !== 'inline' ||
      !anchor.current ||
      document.querySelector('[data-testid="expanded-surface"], [data-streamdown="table-fullscreen"]')
    )
      return
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    innerScroll.current = captureInnerScroll(mount)
    readingScroll.current = []
    for (let parent = anchor.current.parentElement; parent; parent = parent.parentElement) {
      readingScroll.current.push({ element: parent, top: parent.scrollTop, left: parent.scrollLeft })
    }
    anchor.current.style.height = `${anchor.current.getBoundingClientRect().height}px`
    reason.current = 'user'
    mode.current = 'opening'
    setError(false)
    setExpanded(true)
  }, [available, mount])
  const runOutside = useCallback(
    (action: () => void) => {
      if (mode.current === 'inline') {
        action()
        return
      }
      if (pendingAction.current || mode.current === 'closing') return
      pendingAction.current = action
      close('outside-action')
    },
    [close]
  )
  const attachModal = useCallback(
    (element: HTMLDivElement | null) => {
      modal.current = element
      if (!element) return
      try {
        element.appendChild(mount)
        mount.dataset.displayMode = 'expanded'
        mode.current = 'expanded'
        settleScroll()
      } catch {
        reason.current = 'error'
        mode.current = 'closing'
        returnInline()
        setExpanded(false)
        setError(true)
      }
    },
    [mount, returnInline, settleScroll]
  )
  useLayoutEffect(() => {
    mounted.current = true
    ;(modal.current ?? anchor.current)?.appendChild(mount)
    const onScroll = (event: Event): void => {
      if (mode.current !== 'expanded' || !(event.target instanceof HTMLElement)) return
      const element = event.target
      if (!innerScroll.current.has(element)) innerScroll.current.set(element, scrollMemory(element))
      observeInnerScroll(innerScroll.current)
    }
    mount.addEventListener('scroll', onScroll, true)
    return () => {
      mounted.current = false
      reason.current = 'unmount'
      pendingAction.current = null
      cancelFrames()
      mount.removeEventListener('scroll', onScroll, true)
      mount.remove()
    }
  }, [mount, cancelFrames])
  useLayoutEffect(() => {
    if (!available) close('unavailable')
  }, [available, close])
  useLayoutEffect(() => {
    restoreInnerScroll(innerScroll.current)
  }, [expanded])
  useEffect(() => {
    if (expanded || !mounted.current) return
    mode.current = 'inline'
    const action = pendingAction.current
    pendingAction.current = null
    // Dialog's effect cleanup has released its focus/pointer lock before this microtask.
    if (action)
      queueMicrotask(() => {
        if (mounted.current) action()
      })
  }, [expanded])
  const context = useMemo(() => ({ expanded, available, open, close, runOutside }), [expanded, available, open, close, runOutside])
  return (
    <D.Root
      open={expanded}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <div ref={anchor} className="expanded-anchor" tabIndex={-1} role="group" aria-label={title} />
      {createPortal(<PresentationContext.Provider value={context}>{children}</PresentationContext.Provider>, mount, 'surface')}
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-danger">
          {t('ui.expand.failed')}
        </p>
      )}
      {expanded && (
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-[70] bg-black/25" />
          <D.Content
            data-testid="expanded-surface"
            className="expanded-surface chat-md select-text no-drag"
            onPointerDownOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              onEscapeKeyDown?.(event)
              if (event.defaultPrevented) return
              event.preventDefault()
              close('escape')
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              mount.querySelector<HTMLButtonElement>('[data-expand-toggle]')?.focus({ preventScroll: true })
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (reason.current !== 'outside-action' && reason.current !== 'unmount') {
                if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
                else anchor.current?.focus({ preventScroll: true })
              }
            }}
          >
            <D.Title className="sr-only">{title}</D.Title>
            <D.Description className="sr-only">{t('ui.expand.hint')}</D.Description>
            <div ref={attachModal} className="expanded-slot" />
          </D.Content>
        </D.Portal>
      )}
    </D.Root>
  )
}

export function ExpandToggle() {
  const { t } = useTranslation()
  const view = useExpandedPresentation()
  if (!view.available && !view.expanded) return null
  return (
    <button
      type="button"
      data-expand-toggle
      aria-label={t(view.expanded ? 'ui.expand.exit' : 'ui.expand.open')}
      title={t(view.expanded ? 'ui.expand.exit' : 'ui.expand.open')}
      aria-expanded={view.expanded}
      className="no-drag shrink-0 rounded p-1 text-subtle hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent"
      onClick={() => (view.expanded ? view.close() : view.open())}
    >
      {view.expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
    </button>
  )
}
