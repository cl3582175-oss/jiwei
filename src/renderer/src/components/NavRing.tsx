import { Button } from '@/components/ui/shadcn-button'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

// 导航浮卡（v0.7.4）：悬停一级入口时，组图标的底色向右延伸成一张玻璃浮卡，按行列出二级入口
// （图标 · 文字 · 快捷键或角标），当前页高亮。点一级图标立即展开或收起（由调用方处理）；
// Esc 或移开收起；↑↓ 选择、回车进入、数字键直达。浮卡是 role="menu"：盖住内置浏览器时，网页会自动换成截图。

export interface RingItem {
  id: string
  label: string
  /** 快捷键提示，如 ⌘2 */
  hint?: string
  icon: ReactNode
  badge?: number
  current?: boolean
}

const MARGIN = 10
const ROW = 36
const HEAD = 28
const PAD = 6

/** 浮卡的顶端：默认与组图标顶端对齐（两者连成一体）；放不下时整体上移 */
export function flyoutTop(anchorTop: number, rows: number, height: number): number {
  const h = HEAD + rows * ROW + PAD * 2
  return Math.max(MARGIN, Math.min(anchorTop, height - MARGIN - h))
}

export function NavRing({
  anchor,
  title,
  items,
  onSelect,
  onClose,
  focusOnOpen = false,
  onPointerEnter,
  onPointerLeave
}: {
  anchor: HTMLElement
  title: string
  items: RingItem[]
  onSelect: (id: string) => void
  onClose: () => void
  focusOnOpen?: boolean
  onPointerEnter: () => void
  onPointerLeave: () => void
}) {
  const [shown, setShown] = useState(false)
  const [focus, setFocus] = useState(() =>
    Math.max(
      0,
      items.findIndex((i) => i.current)
    )
  )
  const [rect, setRect] = useState<DOMRect | null>(null)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const card = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    setRect(anchor.getBoundingClientRect())
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [anchor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        anchor.focus()
      } else if (e.target !== anchor && !refs.current.some((r) => r === e.target)) return
      else if ((e.key === 'Enter' || e.key === ' ') && refs.current.some((r) => r === e.target)) {
        e.preventDefault()
        onSelect(items[focus].id)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocus((f) => (f + 1) % items.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocus((f) => (f - 1 + items.length) % items.length)
      } else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const it = items[Number(e.key) - 1]
        if (it) {
          e.preventDefault()
          onSelect(it.id)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, onClose, onSelect, anchor, focus])

  // 键盘打开时把焦点放到当前项
  useEffect(() => {
    if (rect && (focusOnOpen || refs.current.some((r) => r === document.activeElement))) refs.current[focus]?.focus()
  }, [focus, anchor, rect, focusOnOpen])

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !anchor.contains(event.target) && !card.current?.contains(event.target)) onClose()
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [anchor, onClose])

  if (!rect) return null
  const top = flyoutTop(rect.top, items.length, window.innerHeight)
  // 与组图标顶端对齐时左上角做成直角，和图标的底色连成一体
  const joined = Math.abs(top - rect.top) < 1

  return createPortal(
    <div role="menu" data-ui-overlay="menu" aria-label={title} data-testid="nav-ring" className="pointer-events-none fixed inset-0 z-50">
      <div
        ref={card}
        className={cn(
          'pointer-events-auto absolute w-[216px] border border-border bg-surface/90 p-1.5 shadow-float backdrop-blur-xl backdrop-saturate-150',
          joined ? 'rounded-tl-none rounded-tr-[14px] rounded-br-[14px] rounded-bl-[14px] border-l-0' : 'rounded-[14px]',
          'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0.9,0.3,1.1)] motion-reduce:transition-opacity',
          shown ? 'translate-x-0 opacity-100' : '-translate-x-1.5 opacity-0'
        )}
        style={{ left: rect.right - 1, top }}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        data-testid="nav-flyout"
      >
        <p className="px-2.5 pt-1 font-serif text-xs tracking-[0.3em] text-subtle" style={{ height: HEAD - 4 }}>
          {title}
        </p>
        {items.map((it, i) => {
          const name = it.hint ? `${it.label}  ${it.hint}` : it.label
          return (
            <Button variant="ghost" size="auto"
              key={it.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              role="menuitem"
              aria-current={it.current ? 'page' : undefined}
              aria-label={name}
              data-testid={`nav-ring-${it.id}`}
              tabIndex={i === focus ? 0 : -1}
              onFocus={() => setFocus(i)}
              onClick={() => onSelect(it.id)}
              className={cn(
                'no-drag flex w-full items-center gap-2.5 rounded-[9px] px-2.5 text-left text-sm outline-none [&>svg]:size-[17px] [&>svg]:shrink-0',
                'transition-[background-color,color,opacity,transform] duration-200 motion-reduce:transition-colors',
                it.current
                  ? 'bg-accent-soft text-accent'
                  : 'text-fg hover:bg-surface-hover focus-visible:bg-surface-hover [&>svg]:text-muted hover:[&>svg]:text-fg',
                'focus-visible:ring-2 focus-visible:ring-accent/40',
                shown ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0'
              )}
              style={{ height: ROW, transitionDelay: shown ? `${30 + i * 30}ms` : '0ms' }}
            >
              {it.icon}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.badge ? (
                <span className="min-w-[18px] rounded-full bg-accent px-1.5 text-center text-[11px] leading-[18px] font-medium text-accent-fg tabular-nums">
                  {it.badge > 99 ? '99+' : it.badge}
                </span>
              ) : (
                it.hint && <span className="text-xs text-subtle">{it.hint}</span>
              )}
            </Button>
          )
        })}
      </div>
    </div>,
    document.body
  )
}
