import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, NotebookPen, PanelBottom, PanelLeft, PanelRight, PanelTop, Plus, Search, X } from 'lucide-react'
import { useApp } from '@/store/app'
import { useNotes, useSettings, useUpdateSettings } from '@/lib/queries'
import { useCreateNote } from '@/lib/shortcuts'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'

// 浏览器旁的笔记栏（v0.7.2）：地址栏上的“记笔记”按钮，以及笔记栏位置与大小的设置。

export type Side = 'left' | 'right' | 'top' | 'bottom'
const SIDES: { side: Side; icon: typeof PanelRight }[] = [
  { side: 'right', icon: PanelRight },
  { side: 'left', icon: PanelLeft },
  { side: 'bottom', icon: PanelBottom },
  { side: 'top', icon: PanelTop }
]
const DEFAULT_SIZE = 40

export function useNoteLayout(): { side: Side; size: number; save: (patch: { noteSide?: Side; noteSize?: number }) => void } {
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const latest = useRef(s)
  latest.current = s
  const side = s?.browser?.noteSide ?? 'right'
  const size = s?.browser?.noteSize ?? DEFAULT_SIZE
  const save = (patch: { noteSide?: Side; noteSize?: number }): void => {
    if (latest.current) update.mutate({ browser: { ...latest.current.browser, ...patch } })
  }
  return { side, size, save }
}

/** 地址栏右侧的“记笔记”：没有笔记时新建；菜单里可打开最近的笔记、调整笔记栏位置、关闭笔记栏 */
export function NoteBarButton() {
  const { t } = useTranslation()
  const browserNote = useApp((s) => s.browserNote)
  const createNote = useCreateNote()
  const { data: notes = [] } = useNotes({ limit: 20 })
  const { side, save } = useNoteLayout()
  const recent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).filter((n) => n.id !== browserNote).slice(0, 6)
  return (
    <div className="flex shrink-0 items-center">
      {!browserNote && (
        <Tip label={t('browser.noteBar.buttonHint')} side="bottom">
          <Button variant="ghost" size="sm" className="h-7 rounded-r-none px-2 text-xs" onClick={() => void createNote()} data-testid="browser-new-note">
            <NotebookPen />
            <span className="hidden @min-[520px]:inline">{t('browser.noteBar.button')}</span>
          </Button>
        </Tip>
      )}
      <Menu>
        <MenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('size-7', !browserNote && 'w-5 rounded-l-none', browserNote && 'bg-accent-soft text-accent')}
            aria-label={browserNote ? t('browser.noteBar.layout') : t('browser.noteBar.recent')}
            data-testid="browser-note-menu"
          >
            {browserNote ? <NotebookPen /> : <ChevronDown className="size-3.5" />}
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => void createNote()}>
            <Plus />
            {t('browser.noteBar.new')}
          </MenuItem>
          {recent.length > 0 && (
            <>
              <MenuLabel>{t('browser.noteBar.recent')}</MenuLabel>
              {recent.map((n) => (
                <MenuItem key={n.id} onSelect={() => useApp.getState().openNote(n.id)}>
                  <span className="max-w-[240px] truncate">{n.title || t('browser.noteBar.untitled')}</span>
                </MenuItem>
              ))}
            </>
          )}
          <MenuItem onSelect={() => useApp.getState().setPaletteOpen(true)}>
            <Search />
            {t('browser.noteBar.search')}
          </MenuItem>
          {browserNote && (
            <>
              <MenuSeparator />
              <MenuLabel>{t('browser.noteBar.layout')}</MenuLabel>
              {SIDES.map(({ side: s, icon: Icon }) => (
                <MenuItem key={s} onSelect={() => save({ noteSide: s })} data-testid={`note-side-${s}`}>
                  <Icon />
                  <span className="flex-1">{t(`browser.noteBar.${s}`)}</span>
                  {side === s && <Check className="text-accent" />}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => useApp.getState().setBrowserNote(null)}>
                <X />
                {t('browser.noteBar.close')}
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
    </div>
  )
}

