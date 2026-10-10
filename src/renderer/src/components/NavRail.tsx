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
  Globe
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp, type View } from '@/store/app'
import { cn, isMac, modKey } from '@/lib/utils'
import { Tip } from './ui/primitives'
import { Logo } from './Logo'
import { JobsIndicator } from './JobsIndicator'
import { useSidebar } from './CollapsibleSidebar'
import { useReviewStats } from '@/features/review/ReviewView'

function RailButton({
  active,
  pressed,
  label,
  onClick,
  badge,
  children
}: {
  active?: boolean
  pressed?: boolean
  label: string
  onClick: () => void
  badge?: number
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
          'no-drag relative grid size-10 place-items-center rounded-[10px] transition-colors duration-150 [&_svg]:size-[19px]',
          active ? 'bg-accent-soft text-accent' : 'text-subtle hover:bg-surface-hover hover:text-fg'
        )}
      >
        {children}
        {!!badge && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-medium text-accent-fg tabular-nums">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        {active && <span className="absolute top-2.5 -left-[17px] h-5 w-[3px] rounded-r-full bg-accent" />}
      </button>
    </Tip>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const { view, setView, openNote, setSettingsOpen, setPaletteOpen, browserOpen } = useApp()
  const sidebar = useSidebar()
  const { data: inbox = [] } = useInbox()
  const { data: stats } = useReviewStats()
  const items: { id: View; label: string; icon: ReactNode }[] = [
    { id: 'notes', label: `${t('nav.notes')}  ${modKey}1`, icon: <NotebookPen /> },
    { id: 'inbox', label: `${t('inbox.title')}  ${modKey}0`, icon: <Inbox /> },
    { id: 'library', label: `${t('nav.library')}  ${modKey}2`, icon: <Library /> },
    { id: 'chat', label: `${t('nav.chat')}  ${modKey}3`, icon: <Sparkles /> },
    { id: 'review', label: `${t('nav.review')}  ${modKey}4`, icon: <Layers /> },
    { id: 'reflect', label: `${t('nav.reflect')}  ${modKey}5`, icon: <Sprout /> },
    { id: 'recording', label: `${t('recording.title')}  ${modKey}7`, icon: <Mic /> },
    { id: 'graph', label: `${t('nav.graph')}  ${modKey}6`, icon: <Network /> }
  ]

  return (
    <nav className={cn('drag flex w-[72px] shrink-0 flex-col items-center gap-1.5 pb-4', isMac ? 'pt-12' : 'pt-3')}>
      <div className="mb-4">
        <Logo />
      </div>
      {/* 侧栏收展：最多四栏并存时，把空间让给资料与笔记 */}
      {view !== 'trash' && (
        <RailButton
          label={`${sidebar.collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}  ${modKey}\\`}
          pressed={!sidebar.collapsed}
          onClick={sidebar.toggle}
        >
          {sidebar.collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </RailButton>
      )}
      <RailButton label={`${t('nav.search')}  ${modKey}K`} onClick={() => setPaletteOpen(true)}>
        <Search />
      </RailButton>
      <div className="my-1.5 h-px w-6 bg-border" />
      {items.map((it) => (
        <RailButton
          key={it.id}
          active={view === it.id}
          label={it.label}
          onClick={() =>
            it.id === 'notes' && view === 'notes' ? openNote(null) : it.id === 'graph' ? useApp.getState().openGraph(null) : setView(it.id)
          }
          badge={
            it.id === 'review'
              ? stats?.due
              : it.id === 'inbox'
                ? inbox.filter((i) => i.status === 'new' || i.status === 'suggested').length
                : undefined
          }
        >
          {it.icon}
        </RailButton>
      ))}
      {/* 内置浏览器（v0.6.0）：在工作区左栏打开，笔记在右栏 */}
      <RailButton
        active={browserOpen && view === 'notes'}
        label={`${t('nav.browser')}  ${modKey}L`}
        onClick={() => (browserOpen && view === 'notes' ? useApp.getState().closeBrowser() : useApp.getState().openBrowser())}
      >
        <Globe />
      </RailButton>
      <div className="flex-1" />
      <JobsIndicator />
      <RailButton active={view === 'trash'} label={t('nav.trash')} onClick={() => setView('trash')}>
        <Trash2 />
      </RailButton>
      <RailButton label={`${t('nav.settings')}  ${modKey},`} onClick={() => setSettingsOpen(true)}>
        <Settings />
      </RailButton>
    </nav>
  )
}
