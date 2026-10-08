import { app, nativeTheme } from 'electron'
import { getDb } from '../db'
import { settings } from '../db/schema'
import type { Settings } from '@shared/types'
import type { SettingsPatch } from '@shared/schemas'

function defaults(): Settings {
  return {
    // JIWEI_LANG 便于测试固定界面语言
    language: (process.env.JIWEI_LANG as Settings['language']) || (app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'),
    theme: 'system',
    palette: 'qinglu',
    // 测试环境可跳过首次引导
    onboarded: process.env.JIWEI_SKIP_ONBOARDING === '1',
    sidebarCollapsed: false,
    // AI：默认思考强度“高”（DeepSeek 默认值）；向量默认使用内置本地模型
    ai: { chat: { providerId: null, model: null }, effort: 'high', embedding: { mode: 'local', providerId: null, model: null } },
    // 默认节奏：每天 1 分钟微复盘 + 每周日晚完整复盘
    reflection: { daily: true, weekly: true, weeklyDay: 0, time: '21:00' },
    // 复习：每天最多 20 张新卡，目标记忆保持率 90%（FSRS 默认）
    review: { newPerDay: 20, retention: 0.9 }
  }
}

export function getSettings(): Settings {
  const rows = getDb().select().from(settings).all()
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  return { ...defaults(), ...stored }
}

export function setSettings(patch: SettingsPatch): Settings {
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
