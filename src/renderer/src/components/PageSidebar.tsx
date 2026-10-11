import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { PanelLeftClose, PanelLeftOpen, Pin } from 'lucide-react'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { cn, modKey } from '@/lib/utils'
import type { SidebarPage } from '@shared/types'

/**
 * 页面列表栏（v0.7.3，书脊式收展）：
 *   - 谁的栏谁带把手：收起按钮在列表栏标题旁（SidebarToggle），导航栏不再放；
 *   - 收起后留一条“书脊”，竖排写着当前位置；悬停片刻，列表以浮层滑出（不挤动正文），移开自动收回；点书脊或浮层上的图钉恢复常驻；
 *   - 右边缘可拖动宽度（220–420），拖过临界点即收起；
 *   - 笔记、资料库、助手各自记住收展与宽度；空间不够时自动收成书脊，空间回来自动展开（只有手动收起的才一直收着）。
 */

export const SIDEBAR_WIDTH = 300
const MIN_WIDTH = 220
const MAX_WIDTH = 420
/** 拖到比这更窄就收起 */
const SNAP_WIDTH = 150
export const SPINE_WIDTH = 16
const PEEK_DELAY = 220
const PEEK_LEAVE = 260

/** 本次会话中“空间不够时自动收起”被用户临时撤销的页面（空间恢复后清除） */
const useOverrides = create<{ expanded: Partial<Record<SidebarPage, boolean>>; set: (p: SidebarPage, v: boolean) => void }>((set) => ({
  expanded: {},
  set: (p, v) => set((s) => ({ expanded: { ...s.expanded, [p]: v } }))
}))

/** 窗口宽度（用于空间不够时自动收起） */
export function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = (): void => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

export interface SidebarState {
  /** 当前是否收成书脊 */
  collapsed: boolean
  /** 是否由空间不足自动收起（而不是用户手动） */
  auto: boolean
  width: number
  toggle: () => void
  setWidth: (w: number, collapse?: boolean) => void
}

/** 某个页面列表栏的状态；auto 为“空间不够”的条件，由页面传入 */
export function usePageSidebar(page: SidebarPage, auto = false): SidebarState {
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const override = useOverrides((o) => !!o.expanded[page])
  const setOverride = useOverrides((o) => o.set)
  const stored = s?.sidebars?.[page]
  // 旧版本只有一个全局开关：没有单独设置时沿用它
  const userCollapsed = stored?.collapsed ?? s?.sidebarCollapsed ?? false
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, stored?.width ?? SIDEBAR_WIDTH))
  // 空间恢复后，撤销记录作废，下次空间不够仍自动收起
  useEffect(() => {
    if (!auto && override) setOverride(page, false)
  }, [auto, override, page, setOverride])
  const latest = useRef(s)
  latest.current = s
  const save = (patch: { collapsed?: boolean; width?: number }): void => {
    const cur = latest.current
    if (!cur) return
    const prev = cur.sidebars?.[page] ?? { collapsed: cur.sidebarCollapsed ?? false, width: SIDEBAR_WIDTH }
    update.mutate({ sidebars: { ...cur.sidebars, [page]: { ...prev, ...patch } } })
  }
  const autoCollapsed = auto && !override
  const collapsed = userCollapsed || autoCollapsed
  return {
    collapsed,
    auto: !userCollapsed && autoCollapsed,
    width,
    toggle: () => {
      if (collapsed) {
        if (userCollapsed) save({ collapsed: false })
        if (auto) setOverride(page, true)
      } else if (auto && override) setOverride(page, false)
      else save({ collapsed: true })
    },
    setWidth: (w, collapse) => save(collapse ? { collapsed: true } : { width: Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))) })
  }
}

/** 当前页面的列表栏（⌘\ 收展它；没有列表栏的页面不响应） */
let activeToggle: (() => void) | null = null
export function toggleActiveSidebar(): boolean {
  if (!activeToggle) return false
  activeToggle()
  return true
}

interface Ctx {
  state: SidebarState
  peeking: boolean
  pin: () => void
}
const SidebarContext = createContext<Ctx | null>(null)

/** 列表栏标题旁的收起按钮；浮层窥视时变为“固定” */
export function SidebarToggle() {
  const { t } = useTranslation()
  const ctx = useContext(SidebarContext)
  if (!ctx) return null
  const label = ctx.peeking ? t('nav.pinSidebar') : `${t('nav.collapseSidebar')}  ${modKey}\\`
  return (
    <Tip label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        className="no-drag"
        aria-label={ctx.peeking ? t('nav.pinSidebar') : t('nav.collapseSidebar')}
        data-testid="sidebar-toggle"
        onClick={() => (ctx.peeking ? ctx.pin() : ctx.state.toggle())}
      >
        {ctx.peeking ? <Pin /> : <PanelLeftClose />}
      </Button>
    </Tip>
  )
}

export function PageSidebar({
  page,
  auto = false,
  label,
  children,
  className
}: {
  page: SidebarPage
  /** 空间不够时自动收起 */
  auto?: boolean
  /** 书脊上竖排显示的当前位置，如“笔记 · 考研数学” */
  label: string
  children: ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  const state = usePageSidebar(page, auto)
  const [peeking, setPeeking] = useState(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const enter = useRef<number | undefined>(undefined)
  const leave = useRef<number | undefined>(undefined)
  const panel = useRef<HTMLDivElement>(null)
  const { collapsed } = state
  const width = dragWidth ?? state.width
  const toggleRef = useRef(state.toggle)
  toggleRef.current = state.toggle
  useEffect(() => {
    const fn = (): void => {
      setPeeking(false)
      toggleRef.current()
    }
    activeToggle = fn
    return () => {
      if (activeToggle === fn) activeToggle = null
    }
  }, [])

  // 展开后不再窥视；离开时清理计时器
  useEffect(() => {
    if (!collapsed) setPeeking(false)
  }, [collapsed])
  useEffect(
    () => () => {
      window.clearTimeout(enter.current)
      window.clearTimeout(leave.current)
    },
    []
  )
  useEffect(() => {
    if (!peeking) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPeeking(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [peeking])

  const startPeek = (): void => {
    window.clearTimeout(leave.current)
    if (peeking) return
    window.clearTimeout(enter.current)
    enter.current = window.setTimeout(() => setPeeking(true), PEEK_DELAY)
  }
  const endPeek = (): void => {
    window.clearTimeout(enter.current)
    window.clearTimeout(leave.current)
    // 浮层里的菜单、对话框挂在别处：鼠标在它们上面时不收回
    leave.current = window.setTimeout(() => {
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"]')) return endPeek()
      setPeeking(false)
    }, PEEK_LEAVE)
  }
  const pin = (): void => {
    setPeeking(false)
    state.toggle()
  }

  /** 拖动右边缘调整宽度；拖得太窄即收起 */
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let last = startW
    const move = (ev: PointerEvent): void => {
      last = startW + ev.clientX - startX
      setDragWidth(Math.min(MAX_WIDTH, Math.max(SNAP_WIDTH - 20, last)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      setDragWidth(null)
      if (last < SNAP_WIDTH) state.setWidth(startW, true)
      else state.setWidth(last)
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const open = !collapsed || peeking
  return (
    <SidebarContext.Provider value={{ state, peeking, pin }}>
      <div
        className="relative h-full shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.2,0.9,0.3,1)]"
        style={{ width: collapsed ? SPINE_WIDTH : width, transitionDuration: dragWidth !== null ? '0ms' : undefined }}
        data-collapsed={collapsed}
        data-peeking={peeking}
        data-testid={`sidebar-${page}`}
      >
        {collapsed && (
          <button
            className="group absolute inset-y-0 left-0 z-10 flex w-[16px] flex-col items-center gap-2 pt-[60px] text-subtle transition-colors hover:bg-surface-hover/70 hover:text-fg"
            onMouseEnter={startPeek}
            onMouseLeave={endPeek}
            onClick={pin}
            aria-label={`${t('nav.expandSidebar')} · ${label}`}
            data-testid="sidebar-spine"
          >
            <PanelLeftOpen className="size-3.5 shrink-0 opacity-70 group-hover:opacity-100" />
            <span className="max-h-[60vh] overflow-hidden text-xs tracking-[0.2em] whitespace-nowrap [writing-mode:vertical-rl]">{label}</span>
          </button>
        )}
        <div
          ref={panel}
          className={cn(
            'h-full overflow-hidden',
            collapsed &&
              'absolute inset-y-2 left-0 z-40 rounded-r-xl border border-l-0 border-border bg-[var(--desk)] shadow-float transition-[transform,opacity] duration-200 ease-out',
            collapsed && !peeking && 'pointer-events-none -translate-x-[105%] opacity-0'
          )}
          style={{ width }}
          inert={!open}
          onMouseEnter={collapsed ? startPeek : undefined}
          onMouseLeave={collapsed ? endPeek : undefined}
          data-testid="sidebar-panel"
        >
          <div className={cn('h-full', className)} style={{ width }}>
            {children}
          </div>
        </div>
        {!collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('nav.resizeSidebar')}
            className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize after:absolute after:inset-y-3 after:left-1/2 after:w-px after:-translate-x-1/2 after:rounded-full after:bg-accent after:opacity-0 after:transition-opacity hover:after:opacity-60"
            onPointerDown={startResize}
            onDoubleClick={() => state.setWidth(SIDEBAR_WIDTH)}
            data-testid="sidebar-resize"
          />
        )}
      </div>
    </SidebarContext.Provider>
  )
}
