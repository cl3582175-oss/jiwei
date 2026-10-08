import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Toaster } from 'sonner'
import { useSettings } from './lib/queries'
import { useApp } from './store/app'
import { TooltipProvider } from './components/ui/primitives'
import { DialogHost } from './components/ui/confirm'
import { NavRail } from './components/NavRail'
import { NotesView } from './features/notes/NotesView'
import { LibraryView } from './features/library/LibraryView'
import { TrashView } from './features/trash/TrashView'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { CommandPalette } from './features/palette/CommandPalette'
import { useGlobalShortcuts } from './lib/shortcuts'

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
    document.documentElement.dataset.accent = s?.accent ?? 'jade'
  }, [s?.accent])

  useEffect(() => {
    if (s?.language && i18n.language !== s.language) {
      void i18n.changeLanguage(s.language)
      document.documentElement.lang = s.language
    }
  }, [s?.language, i18n])

  return mode === 'dark' || (mode === 'system' && prefersDark.matches) ? 'dark' : 'light'
}

export function App() {
  const theme = useThemeSync()
  const view = useApp((s) => s.view)
  const { isSuccess } = useSettings()
  useGlobalShortcuts()

  // 设置加载完成前不渲染，避免语言/主题闪烁
  if (!isSuccess) return null

  return (
    <TooltipProvider>
      <div className="flex h-full bg-bg">
        <NavRail />
        <main className="relative min-w-0 flex-1">
          {view === 'notes' && <NotesView />}
          {view === 'library' && <LibraryView />}
          {view === 'trash' && <TrashView />}
        </main>
      </div>
      <SettingsDialog />
      <CommandPalette />
      <DialogHost />
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
