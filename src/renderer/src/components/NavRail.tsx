import { useTranslation } from 'react-i18next'
import { NotebookPen, Library, Trash2, Settings, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp, type View } from '@/store/app'
import { cn, isMac, modKey } from '@/lib/utils'
import { Tip } from './ui/primitives'
import { Logo } from './Logo'
import { JobsIndicator } from './JobsIndicator'

function RailButton({ active, label, onClick, children }: { active?: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={label}>
      <button
        onClick={onClick}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'no-drag relative grid size-10 place-items-center rounded-[10px] transition-colors duration-150 [&_svg]:size-[19px]',
          active ? 'bg-accent-soft text-accent' : 'text-subtle hover:bg-surface-hover hover:text-fg'
        )}
      >
        {children}
        {active && <span className="absolute top-2.5 -left-[17px] h-5 w-[3px] rounded-r-full bg-accent" />}
      </button>
    </Tip>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const { view, setView, openNote, setSettingsOpen, setPaletteOpen } = useApp()
  const items: { id: View; label: string; icon: ReactNode }[] = [
    { id: 'notes', label: `${t('nav.notes')}  ${modKey}1`, icon: <NotebookPen /> },
    { id: 'library', label: `${t('nav.library')}  ${modKey}2`, icon: <Library /> }
  ]

  return (
    <nav
      className={cn(
        'drag flex w-[72px] shrink-0 flex-col items-center gap-1.5 border-r border-border bg-sunken pb-4',
        isMac ? 'pt-12' : 'pt-3'
      )}
    >
      <div className="mb-4">
        <Logo />
      </div>
      <RailButton label={`${t('nav.search')}  ${modKey}K`} onClick={() => setPaletteOpen(true)}>
        <Search />
      </RailButton>
      <div className="my-1.5 h-px w-6 bg-border" />
      {items.map((it) => (
        <RailButton
          key={it.id}
          active={view === it.id}
          label={it.label}
          onClick={() => (it.id === 'notes' && view === 'notes' ? openNote(null) : setView(it.id))}
        >
          {it.icon}
        </RailButton>
      ))}
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
