import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettings } from './queries'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const subscribe = (notify: () => void): (() => void) => {
  darkQuery.addEventListener('change', notify)
  return () => darkQuery.removeEventListener('change', notify)
}
const prefersDark = (): boolean => darkQuery.matches

/** A reactive resolved mode shared by document, previews, and Sonner. */
export function useResolvedTheme(mode: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  const systemDark = useSyncExternalStore(subscribe, prefersDark, () => false)
  return mode === 'dark' || (mode === 'system' && systemDark) ? 'dark' : 'light'
}

export function useThemeSync(): 'light' | 'dark' {
  const { data: settings } = useSettings()
  const { i18n } = useTranslation()
  const theme = useResolvedTheme(settings?.theme ?? 'system')
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => { document.documentElement.dataset.palette = settings?.palette ?? 'qinglu' }, [settings?.palette])
  useEffect(() => {
    if (!settings?.language) return
    document.documentElement.lang = settings.language
    if (i18n.language !== settings.language) void i18n.changeLanguage(settings.language)
  }, [settings?.language, i18n])
  return theme
}
