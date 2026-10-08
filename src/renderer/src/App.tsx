import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Toaster } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { invalidate, useSettings } from './lib/queries'
import { useApp } from './store/app'
import { TooltipProvider } from './components/ui/primitives'
import { DialogHost } from './components/ui/confirm'
import { NavRail } from './components/NavRail'
import { NotesView } from './features/notes/NotesView'
import { LibraryView } from './features/library/LibraryView'
import { TrashView } from './features/trash/TrashView'
import { ChatView } from './features/chat/ChatView'
import { ReviewView } from './features/review/ReviewView'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { CommandPalette } from './features/palette/CommandPalette'
import { Onboarding } from './features/onboarding/Onboarding'
import { useGlobalShortcuts } from './lib/shortcuts'
import { useCelebrations } from './lib/celebrate'
import { useMemoryToasts } from './features/memory/useMemoryToasts'
import { SelectionToolbar } from './features/assist/SelectionToolbar'
import { AnswerCard } from './features/assist/AnswerCard'

function useThemeSync(): 'light' | 'dark' {
  const { data: s } = useSettings()
  const { i18n } = useTranslation()
  const mode = s?.theme ?? 'system'
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')

  useEffect(() => {
    const apply = (): void => {
      const dark = mode === 'dark' || (mode === 'system' && prefersDark.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    prefersDark.addEventListener('change', apply)
    return () => prefersDark.removeEventListener('change', apply)
  }, [mode, prefersDark])

  useEffect(() => {
    document.documentElement.dataset.palette = s?.palette ?? 'qinglu'
  }, [s?.palette])

  useEffect(() => {
    if (s?.language && i18n.language !== s.language) {
      void i18n.changeLanguage(s.language)
      document.documentElement.lang = s.language
    }
  }, [s?.language, i18n])

  return mode === 'dark' || (mode === 'system' && prefersDark.matches) ? 'dark' : 'light'
}

/** 主进程派生数据更新后刷新列表与当前笔记 */
function useMainEvents(): void {
  const qc = useQueryClient()
  // 深层链接：jiwei://note/<id>、jiwei://source/<id>
  useEffect(
    () =>
      window.jiweiEvents.on('nav:open', (p) => {
        const s = useApp.getState()
        if (p.type === 'note') s.openNote(p.id)
        else s.openSource(p.id)
      }),
    []
  )
  useEffect(() => {
    let timer: number | undefined
    const ids = new Set<string>()
    return window.jiweiEvents.on('notes:changed', (p) => {
      p.ids.forEach((id) => ids.add(id))
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        invalidate(qc, 'notes', 'heatmap')
        for (const id of ids) {
          void qc.invalidateQueries({ queryKey: ['note', id] })
          void qc.invalidateQueries({ queryKey: ['blocks', id] })
        }
        ids.clear()
      }, 250)
    })
  }, [qc])
}

export function App() {
  const theme = useThemeSync()
  useMainEvents()
  const view = useApp((s) => s.view)
  const { isSuccess } = useSettings()
  useGlobalShortcuts()
  useCelebrations()
  useMemoryToasts()

  // 设置加载完成前不渲染，避免语言/主题闪烁
  if (!isSuccess) return null

  return (
    <TooltipProvider>
      <div className="flex h-full">
        <NavRail />
        <main className="relative min-w-0 flex-1">
          {view === 'notes' && <NotesView />}
          {view === 'library' && <LibraryView />}
          {view === 'chat' && <ChatView />}
          {view === 'review' && <ReviewView />}
          {view === 'trash' && <TrashView />}
        </main>
      </div>
      <SettingsDialog />
      <CommandPalette />
      <Onboarding />
      <DialogHost />
      <SelectionToolbar />
      <AnswerCard />
      <Toaster
        theme={theme}
        position="bottom-center"
        toastOptions={{
          className: '!rounded-lg !border !border-border !bg-surface !text-fg !shadow-float !text-sm !font-sans'
        }}
      />
    </TooltipProvider>
  )
}
