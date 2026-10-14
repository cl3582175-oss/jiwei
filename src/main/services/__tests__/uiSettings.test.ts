import { beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { settings } from '../../db/schema'
import { SettingsPatchSchema } from '@shared/schemas'

const fixture = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }))
vi.mock('electron', () => ({ app: { getLocale: () => 'zh-CN' }, nativeTheme: { themeSource: 'system' } }))
vi.mock('../../db', () => ({ getDb: () => fixture.db }))
vi.mock('../../events', () => ({ emit: () => undefined }))
import { getSettings, setSettings } from '../settings'

beforeEach(() => {
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  fixture.db = drizzle(sqlite)
})
it('旧设置补齐组件默认值，局部更新不会抹掉密度与既有 AI 字段', () => {
  fixture
    .db!.insert(settings)
    .values({
      key: 'ai',
      value: JSON.stringify({
        chat: { providerId: null, model: null },
        effort: 'off',
        embedding: { mode: 'local', providerId: null, model: null }
      })
    })
    .run()
  expect(getSettings().ai.ui).toEqual({ density: 'normal', dataAccess: true, inline: true, localModels: 'off' })
  const current = getSettings().ai
  setSettings({ ai: { ...current, ui: { ...current.ui, density: 'rich', localModels: 'normal' } } })
  const patch = SettingsPatchSchema.parse({ ai: { ...getSettings().ai, ui: { dataAccess: false } } })
  setSettings(patch)
  expect(getSettings().ai.ui).toEqual({ density: 'rich', dataAccess: false, inline: true, localModels: 'normal' })
  expect(getSettings().ai.effort).toBe('off')
})
