import { useEffect, type ReactNode } from 'react'
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
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Layers,
  Sprout,
  Network,
  Globe,
  Sun,
  FolderInput,
  BookOpen,
  CalendarRange,
  Target,
  GraduationCap
} from 'lucide-react'
import { useApp, NAV_GROUPS, currentNavItem, groupOf, type NavGroup, type NavItem } from '@/store/app'
import { cn, isMac, modKey } from '@/lib/utils'
import { Tip } from './ui/primitives'
import { Logo } from './Logo'
import { JobsIndicator } from './JobsIndicator'
import { useSidebar } from './CollapsibleSidebar'
import { useReviewStats } from '@/features/review/ReviewView'
import { useAssist } from '@/features/assist/store'

// 左侧导航（v0.6.7）：顶部是积微助手，其下按学习闭环分组——今日 · 收集 · 学习 · 计划。
// 点组图标回到这组上次去过的页面，当前所在的组展开显示它的各项。快捷键保持不变。

function RailButton({
  active,
  pressed,
  label,
  onClick,
  badge,
  small,
  accent,
  children
}: {
  active?: boolean
  pressed?: boolean
  label: string
  onClick: () => void
  badge?: number
  small?: boolean
  accent?: boolean
  children: ReactNode
}) {
  return (
    <Tip label={label}>
      <button
        onClick={onClick}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        aria-pressed={pressed}
        className={cn(
          'no-drag relative grid place-items-center transition-colors duration-150',
          small ? 'size-8 rounded-lg [&_svg]:size-[16px]' : 'size-10 rounded-[10px] [&_svg]:size-[19px]',
          accent
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
        {active && !small && !accent && <span className="absolute top-2.5 -left-[17px] h-5 w-[3px] rounded-r-full bg-accent" />}
      </button>
    </Tip>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const { view, setSettingsOpen, setPaletteOpen, browserOpen, lastInGroup, goNav } = useApp()
  const sidebar = useSidebar()
  const { data: inbox = [] } = useInbox()
  const { data: stats } = useReviewStats()
  const inboxCount = inbox.filter((i) => i.status === 'new' || i.status === 'suggested').length
  const current = currentNavItem({ view, browserOpen })
  const currentGroup = current ? groupOf(current) : null

  // 通过快捷键、链接等其他途径到达的页面，也记为这组的“上次”
  useEffect(() => {
    if (current && useApp.getState().lastInGroup[groupOf(current)] !== current)
      useApp.setState((s) => ({ lastInGroup: { ...s.lastInGroup, [groupOf(current)]: current } }))
  }, [current])

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
    goals: { label: t('nav.goals'), icon: <Target /> },
    reflect: { label: `${t('nav.reflect')}  ${modKey}5`, icon: <Sprout /> }
  }
  const groups: Record<NavGroup, { label: string; icon: ReactNode }> = {
    today: { label: `${t('nav.today')}  ${modKey}9`, icon: <Sun /> },
    collect: { label: t('nav.groups.collect'), icon: <FolderInput /> },
    learn: { label: t('nav.groups.learn'), icon: <BookOpen /> },
    plan: { label: t('nav.groups.plan'), icon: <CalendarRange /> }
  }
  const groupBadge = (g: NavGroup): number | undefined => {
    const n = NAV_GROUPS[g].reduce((sum, i) => sum + (item[i].badge ?? 0), 0)
    return n || undefined
  }

  return (
    <nav className={cn('drag flex w-[72px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto pb-4', isMac ? 'pt-12' : 'pt-3')} data-testid="nav-rail">
      <div className="mb-3">
        <Logo />
      </div>
      {/* 积微助手：全屏页；⌘J 在任何页面打开侧栏 */}
      <RailButton
        accent
        active={view === 'chat'}
        label={`${t('nav.assistant')}  ${modKey}3 · ${t('nav.assistantPanel')} ${modKey}J`}
        onClick={() => {
          useAssist.getState().setPanel({ panelOpen: false })
          useApp.getState().setView('chat')
        }}
      >
        <Sparkles />
      </RailButton>
      <RailButton label={`${t('nav.search')}  ${modKey}K`} onClick={() => setPaletteOpen(true)}>
        <Search />
      </RailButton>
      {/* 侧栏收展：最多四栏并存时，把空间让给资料与笔记 */}
      {['notes', 'library', 'chat', 'review', 'reflect'].includes(view) && !(view === 'notes' && browserOpen) && (
        <RailButton
          label={`${sidebar.collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}  ${modKey}\\`}
          pressed={!sidebar.collapsed}
          onClick={sidebar.toggle}
        >
          {sidebar.collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </RailButton>
      )}
      <div className="my-1.5 h-px w-6 shrink-0 bg-border" />
      {(Object.keys(NAV_GROUPS) as NavGroup[]).map((g) => {
        const open = currentGroup === g && NAV_GROUPS[g].length > 1
        return (
          <div key={g} className={cn('flex flex-col items-center gap-1', open && 'rounded-xl bg-sunken/70 pb-1.5')} data-testid={`nav-group-${g}`}>
            <RailButton
              active={currentGroup === g}
              label={groups[g].label}
              badge={open ? undefined : groupBadge(g)}
              onClick={() => goNav(lastInGroup[g] ?? NAV_GROUPS[g][0])}
            >
              {groups[g].icon}
            </RailButton>
            {open &&
              NAV_GROUPS[g].map((i) => (
                <RailButton key={i} small active={current === i} label={item[i].label} badge={item[i].badge} onClick={() => goNav(i)}>
                  {item[i].icon}
                </RailButton>
              ))}
          </div>
        )
      })}
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
