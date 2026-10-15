import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NavRing } from './NavRing'
import { useInbox } from '@/features/inbox/InboxView'
import { useTranslation } from 'react-i18next'
import {
  Mic,
  Inbox,
  NotebookPen,
  Library,
  Trash2,
  Settings,
  Search,
  Sparkles,
  Layers,
  Sprout,
  Network,
  Globe,
  Sun,
  FolderInput,
  BookOpen,
  CalendarRange,
  Feather,
  PenLine,
  Scale,
  CalendarDays,
  Target,
  GraduationCap
} from 'lucide-react'
import { useApp, NAV_GROUPS, currentNavItem, groupOf, type NavGroup, type NavItem } from '@/store/app'
import { cn, isMac, modKey } from '@/lib/utils'
import { Tip } from './ui/primitives'
import { Logo } from './Logo'
import { JobsIndicator } from './JobsIndicator'
import { useReviewStats } from '@/features/review/ReviewView'

// 左侧导航（v0.6.7，v0.7.4 改为浮卡）：顶部是积微助手，其下按学习闭环分组——今日 · 收集 · 学习 · 计划。
// 点组图标展开二级入口，不改变当前页面；停在组图标上，组图标的底色向右延伸成玻璃浮卡，按行列出二级入口（NavRing）。
// 导航栏高度从此固定，当前所在的二级页面以组图标右下角的小标显示。快捷键保持不变。

const OPEN_DELAY = 120
const CLOSE_DELAY = 220
const HINT_KEY = 'jiwei.hint.navRing'

function RailButton({
  active,
  pressed,
  label,
  onClick,
  badge,
  small,
  accent,
  noTip,
  sub,
  buttonRef,
  onPointerEnter,
  onPointerLeave,
  onKeyDown,
  expanded,
  children
}: {
  active?: boolean
  pressed?: boolean
  label: string
  onClick: () => void
  badge?: number
  small?: boolean
  accent?: boolean
  /** 有半环的组不显示提示气泡（半环本身就是说明） */
  noTip?: boolean
  /** 当前所在的二级页面图标（组图标右下角的小标） */
  sub?: ReactNode
  buttonRef?: (el: HTMLButtonElement | null) => void
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  expanded?: boolean
  children: ReactNode
}) {
  const button = (
    <button
      ref={buttonRef}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
      aria-haspopup={expanded !== undefined ? 'menu' : undefined}
      aria-expanded={expanded}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      aria-pressed={pressed}
      className={cn(
        'no-drag relative grid place-items-center transition-[background-color,color,border-radius] duration-150',
        small ? 'size-8 rounded-lg [&_svg]:size-[16px]' : 'size-10 rounded-[10px] [&_svg]:size-[19px]',
        expanded
          ? 'z-[51] rounded-r-none border border-r-0 border-border bg-surface/90 text-accent backdrop-blur-xl'
          : accent
            ? active
              ? 'bg-accent text-accent-fg'
              : 'bg-accent-soft text-accent hover:bg-accent hover:text-accent-fg'
            : active
              ? 'bg-accent-soft text-accent'
              : 'text-subtle hover:bg-surface-hover hover:text-fg'
      )}
    >
      {children}
      {!!badge && (
        <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-medium text-accent-fg tabular-nums">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {sub && (
        <span
          className="absolute -bottom-1 -left-1 grid size-[18px] place-items-center rounded-full border border-accent/40 bg-surface text-accent shadow-card [&_svg]:size-[11px]"
          data-testid="nav-sub"
        >
          {sub}
        </span>
      )}
      {active && !small && !accent && <span className="absolute top-2.5 -left-[17px] h-5 w-[3px] rounded-r-full bg-accent" />}
    </button>
  )
  return noTip ? button : <Tip label={label}>{button}</Tip>
}

/** 首次提示浮在窗口上（导航栏会裁掉超出宽度的内容） */
function RingHint({ anchor, text, leaving }: { anchor: () => HTMLElement | null; text: string; leaving: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const place = (): void => {
      const r = anchor()?.getBoundingClientRect()
      if (r) setPos({ x: r.right + 12, y: r.top + r.height / 2 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])
  if (!pos) return null
  return createPortal(
    <span className="pointer-events-none fixed z-40 -translate-y-1/2" style={{ left: pos.x, top: pos.y }} data-testid="nav-ring-hint">
      <span
        className={cn(
          'relative flex animate-[fade-in_400ms_ease-out] items-center rounded-lg border border-accent/30 bg-surface px-3 py-1.5 text-sm whitespace-nowrap text-muted shadow-float',
          'transition-[opacity,transform] duration-[600ms] ease-out motion-reduce:transition-opacity',
          leaving && '-translate-x-1 opacity-0'
        )}
      >
        <span className="absolute top-1/2 -left-[5px] size-2.5 -translate-y-1/2 rotate-45 border-b border-l border-accent/30 bg-surface" />
        {text}
      </span>
    </span>,
    document.body
  )
}

/** 首次使用的轻提示：停在组图标上可以看到全部入口（只出现一次）。淡入，停留约 3.5 秒后用 0.6 秒淡出 */
const HINT_STAY = 3500
const HINT_FADE = 600
function useRingHint(): [boolean, boolean, () => void] {
  const [show, setShow] = useState(() => {
    try {
      return !localStorage.getItem(HINT_KEY)
    } catch {
      return false
    }
  })
  const done = (): void => {
    setShow(false)
    try {
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      // 存不了就下次再提示
    }
  }
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (!show) return
    const fade = window.setTimeout(() => setLeaving(true), HINT_STAY)
    const end = window.setTimeout(done, HINT_STAY + HINT_FADE)
    return () => {
      window.clearTimeout(fade)
      window.clearTimeout(end)
    }
  }, [show])
  return [show, leaving, done]
}

export function NavRail() {
  const { t } = useTranslation()
  const { view, setSettingsOpen, setPaletteOpen, browserOpen, goNav } = useApp()
  const { data: inbox = [] } = useInbox()
  const { data: stats } = useReviewStats()
  const inboxCount = inbox.filter((i) => i.status === 'new' || i.status === 'suggested').length
  const current = currentNavItem({ view, browserOpen })
  const currentGroup = current ? groupOf(current) : null

  const item: Record<NavItem, { label: string; icon: ReactNode; badge?: number }> = {
    today: { label: `${t('nav.today')}  ${modKey}9`, icon: <Sun /> },
    inbox: { label: `${t('inbox.title')}  ${modKey}0`, icon: <Inbox />, badge: inboxCount },
    library: { label: `${t('nav.library')}  ${modKey}2`, icon: <Library /> },
    browser: { label: `${t('nav.browser')}  ${modKey}L`, icon: <Globe /> },
    recording: { label: `${t('recording.title')}  ${modKey}7`, icon: <Mic /> },
    notes: { label: `${t('nav.notes')}  ${modKey}1`, icon: <NotebookPen /> },
    review: { label: `${t('nav.review')}  ${modKey}4`, icon: <Layers />, badge: stats?.due },
    feynman: { label: t('nav.feynman'), icon: <GraduationCap /> },
    graph: { label: `${t('nav.graph')}  ${modKey}6`, icon: <Network /> },
    calendar: { label: t('plan.calendar'), icon: <CalendarDays /> },
    goals: { label: t('nav.goals'), icon: <Target /> },
    reflect: { label: `${t('nav.reflect')}  ${modKey}5`, icon: <Sprout /> },
    advisor: { label: t('nav.advisor'), icon: <Scale /> },
    works: { label: t('nav.works'), icon: <PenLine /> }
  }
  const groups: Record<NavGroup, { label: string; icon: ReactNode }> = {
    today: { label: `${t('nav.today')}  ${modKey}9`, icon: <Sun /> },
    collect: { label: t('nav.groups.collect'), icon: <FolderInput /> },
    learn: { label: t('nav.groups.learn'), icon: <BookOpen /> },
    create: { label: t('nav.groups.create'), icon: <Feather /> },
    plan: { label: t('nav.groups.plan'), icon: <CalendarRange /> }
  }
  // 半环：悬停片刻展开，移开片刻收起
  const [ring, setRing] = useState<NavGroup | null>(null)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const anchors = useRef<Partial<Record<NavGroup, HTMLButtonElement | null>>>({})
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)
  const [hint, hintLeaving, doneHint] = useRingHint()
  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current)
      window.clearTimeout(closeTimer.current)
    },
    []
  )
  const keep = (): void => window.clearTimeout(closeTimer.current)
  const scheduleOpen = (g: NavGroup): void => {
    keep()
    window.clearTimeout(openTimer.current)
    if (NAV_GROUPS[g].length < 2) return setRing(null)
    openTimer.current = window.setTimeout(
      () => {
        setKeyboardOpen(false)
        setRing(g)
        doneHint()
      },
      ring ? 0 : OPEN_DELAY
    )
  }
  const scheduleClose = (): void => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      // 鼠标仍停在组图标或半环上（进出事件的顺序并不总是可靠）：不收起
      const hovered =
        document.querySelector('[data-testid="nav-ring"] :hover') ||
        document.querySelector('[data-testid="nav-rail"] [aria-expanded="true"]:hover')
      if (!hovered) setRing(null)
    }, CLOSE_DELAY)
  }
  const close = (): void => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    setRing(null)
  }
  const expand = (g: NavGroup, keyboard: boolean): void => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    setKeyboardOpen(keyboard)
    setRing(g)
    doneHint()
  }
  const select = (i: NavItem): void => {
    close()
    goNav(i)
  }

  const groupBadge = (g: NavGroup): number | undefined => {
    const n = NAV_GROUPS[g].reduce((sum, i) => sum + (item[i].badge ?? 0), 0)
    return n || undefined
  }

  return (
    <nav
      className={cn('drag flex w-[72px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto pb-4', isMac ? 'pt-12' : 'pt-3')}
      data-testid="nav-rail"
    >
      <div className="mb-3">
        <Logo />
      </div>
      {/* 积微助手：全屏页；⌘J 在任何页面打开侧栏 */}
      <RailButton
        accent
        active={view === 'chat'}
        label={`${t('nav.assistant')}  ${modKey}3 · ${t('nav.assistantPanel')} ${modKey}J`}
        onClick={() => {
          useApp.getState().setView('chat')
        }}
      >
        <Sparkles />
      </RailButton>
      <RailButton label={`${t('nav.search')}  ${modKey}K`} onClick={() => setPaletteOpen(true)}>
        <Search />
      </RailButton>
      <div className="my-1.5 h-px w-6 shrink-0 bg-border" />
      {(Object.keys(NAV_GROUPS) as NavGroup[]).map((g) => {
        const multi = NAV_GROUPS[g].length > 1
        const here = currentGroup === g && current ? current : null
        const name = groups[g].label
        return (
          <div key={g} className="relative flex flex-col items-center" data-testid={`nav-group-${g}`}>
            <RailButton
              active={currentGroup === g}
              label={here && multi ? `${name} · ${item[here].label.split('  ')[0]}` : name}
              noTip={multi}
              expanded={multi ? ring === g : undefined}
              badge={groupBadge(g)}
              sub={here && multi ? item[here].icon : undefined}
              buttonRef={(el) => {
                anchors.current[g] = el
              }}
              onPointerEnter={() => scheduleOpen(g)}
              onPointerLeave={scheduleClose}
              onKeyDown={(e) => {
                if (multi && ['ArrowRight', 'Enter', ' '].includes(e.key)) {
                  e.preventDefault()
                  expand(g, true)
                }
              }}
              onClick={() => {
                if (!multi) select(NAV_GROUPS[g][0])
                else if (ring === g) close()
                else expand(g, false)
              }}
            >
              {groups[g].icon}
            </RailButton>
          </div>
        )
      })}
      {hint && !ring && <RingHint anchor={() => anchors.current.collect ?? null} text={t('nav.ringHint')} leaving={hintLeaving} />}
      {ring && anchors.current[ring] && (
        <NavRing
          key={ring}
          anchor={anchors.current[ring]!}
          title={groups[ring].label}
          items={NAV_GROUPS[ring].map((i) => {
            const [label, hint] = item[i].label.split('  ')
            return { id: i, label, hint, icon: item[i].icon, badge: item[i].badge, current: current === i }
          })}
          onSelect={(id) => select(id as NavItem)}
          onClose={close}
          focusOnOpen={keyboardOpen}
          onPointerEnter={keep}
          onPointerLeave={scheduleClose}
        />
      )}
      <div className="flex-1" />
      <JobsIndicator />
      <RailButton active={view === 'trash'} label={t('nav.trash')} onClick={() => useApp.getState().setView('trash')}>
        <Trash2 />
      </RailButton>
      <RailButton label={`${t('nav.settings')}  ${modKey},`} onClick={() => setSettingsOpen(true)}>
        <Settings />
      </RailButton>
    </nav>
  )
}
