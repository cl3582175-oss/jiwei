import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { uiToText, type UiNode } from '@shared/ui/catalog'
import type { UiContext } from './context'
import { canReply, restyle } from './reply'
import { SaveToNote } from './SaveToNote'
import { UiTypeIcon } from './typeIcon'
import { collectSvgImage, EMBED_SVG_SELECTOR } from '@/features/notes/exportNote'

export function UiFrame({
  node,
  type,
  uiKey,
  state,
  ctx,
  raw,
  children,
  asText,
  title
}: {
  node?: UiNode
  type?: string
  uiKey: string
  state: 'streaming' | 'ready' | 'fallback'
  ctx: UiContext
  raw: string
  children: ReactNode
  asText: boolean
  title?: string
}) {
  const { t } = useTranslation()
  const host = useRef<HTMLElement>(null)
  const [hasSvg, setHasSvg] = useState(false)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const check = (): void => setHasSvg(!!el.querySelector(EMBED_SVG_SELECTOR))
    check()
    const observer = new MutationObserver(check)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  const [menu, setMenu] = useState(false),
    [showRaw, setShowRaw] = useState(false),
    [save, setSave] = useState(false)
  const disabled = state === 'streaming' || ctx.streaming || ctx.stopped
  const items = [
    ...(node
      ? [
          {
            label: t(asText ? 'ui.menu.asComponent' : 'ui.menu.asText'),
            run: () => {
              ctx.setState(uiKey, { asText: !asText })
              return ctx.flushState?.(uiKey)
            }
          },
          {
            label: t('ui.menu.restyle'),
            disabled: !canReply(ctx),
            run: () => restyle(ctx, node, uiKey)
          },
          {
            label: t('ui.menu.saveToNote'),
            run: () => setSave(true)
          },
          {
            label: t('ui.menu.copy'),
            run: () => navigator.clipboard.writeText(uiToText(node))
          }
        ]
      : []),
    ...(node && hasSvg
      ? [
          {
            label: t('ui.menu.exportImage'),
            run: async () => {
              const picture = host.current && (await collectSvgImage(host.current))
              if (!picture?.svg) return
              const url = URL.createObjectURL(new Blob([picture.svg], { type: 'image/svg+xml' })),
                link = document.createElement('a')
              link.href = url
              link.download = `${(node.title ?? node.type).replace(/[\\/:*?"<>|]/g, '-')}.svg`
              link.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            }
          }
        ]
      : []),
    ...(state === 'fallback' ? [{ label: t('ui.menu.raw'), run: () => setShowRaw(true) }] : [])
  ]
  return (
    <section
      ref={host}
      data-testid="ui-block"
      data-ui-type={type ?? 'unknown'}
      data-ui-state={state}
      data-ui-key={uiKey}
      data-ui-display={asText ? 'text' : 'component'}
      className="relative my-3 min-w-0 overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-[var(--shadow-1)]"
    >
      <header className="flex min-h-9 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <UiTypeIcon type={type} />
          <span className="min-w-0 truncate text-sm font-medium">{node?.title ?? (node?.type === 'diagram' ? node.diagramTitle : undefined) ?? title ?? ''}</span>
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-subtle hover:bg-sunken disabled:opacity-40"
          aria-label={t('ui.menu.label')}
          aria-haspopup="menu"
          aria-expanded={menu}
          disabled={disabled}
          onClick={() => setMenu(!menu)}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </header>
      {menu && (
        <div
          role="menu"
          className="absolute top-10 right-2 z-20 min-w-40 rounded-lg border border-border bg-surface p-1 shadow-card"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setMenu(false)
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
            }
          }}
        >
          {items.map((item) => (
            <button
              type="button"
              role="menuitem"
              key={item.label}
              disabled={disabled || ('disabled' in item && item.disabled === true)}
              title={'disabled' in item && item.disabled ? t('ui.latestOnly') : undefined}
              className="block w-full rounded px-3 py-2 text-left text-xs hover:bg-sunken focus:bg-sunken"
              onClick={() => {
                void Promise.resolve(item.run())
                  .then(() => setMenu(false))
                  .catch((e) => toast.error(String(e)))
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {children}
      {save && node && <SaveToNote node={node} uiKey={uiKey} ctx={ctx} onClose={() => setSave(false)} />}
      {ctx.stopped && state === 'streaming' && <p className="px-4 pb-3 text-2xs text-subtle">{t('ui.unfinished')}</p>}
      {node?.note && <p className="px-4 pb-3 text-2xs text-subtle">{node.note}</p>}
      {showRaw && (
        <details open className="border-t border-border px-4 py-3">
          <summary>{t('ui.menu.raw')}</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-2xs">{raw}</pre>
        </details>
      )}
    </section>
  )
}
