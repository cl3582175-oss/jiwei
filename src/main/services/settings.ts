import { app, nativeTheme } from 'electron'
import { getDb } from '../db'
import { settings } from '../db/schema'
import type { Settings } from '@shared/types'

function defaults(): Settings {
  return {
    // JIWEI_LANG 便于测试固定界面语言
    language: (process.env.JIWEI_LANG as Settings['language']) || (app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'),
    theme: 'system',
    accent: 'jade'
  }
}

export function getSettings(): Settings {
  const rows = getDb().select().from(settings).all()
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  return { ...defaults(), ...stored }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const db = getDb()
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      tx.insert(settings)
        .values({ key, value: JSON.stringify(value) })
        .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value) } })
        .run()
    }
  })
  const next = getSettings()
  applyNativeTheme(next)
  return next
}

/** 同步原生主题，使系统菜单、滚动条等跟随应用主题 */
export function applyNativeTheme(s: Settings): void {
  nativeTheme.themeSource = s.theme
}
