import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SettingsPatch } from '@shared/schemas'
import type { Settings } from '@shared/types'

const fixture = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }))
vi.mock('electron', () => ({ app: { getLocale: () => 'zh-CN' }, nativeTheme: { themeSource: 'system' } }))
vi.mock('../../db', () => ({ getDb: () => fixture.db }))
vi.mock('../../events', () => ({ emit: () => undefined }))
import { getSettings, setSettings } from '../settings'
import { createSettingsUpdates } from '../../../renderer/src/lib/settingsUpdates'

// Exercise the generic settings coordinator with its public updater contract.
// The released AI settings frontend is deliberately outside this refactor.
const budgetUpdate = (patch: Partial<Settings['budget']>) => (current: Settings) => ({ budget: { ...current.budget, ...patch } })

let directory: string
let sqlite: Database.Database

function connect(): void {
  sqlite = new Database(join(directory, 'settings.sqlite'))
  sqlite.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  fixture.db = drizzle(sqlite)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jiwei-settings-merge-'))
  connect()
})

afterEach(() => {
  sqlite.close()
  fixture.db = null
  rmSync(directory, { recursive: true, force: true })
})

describe('settings storage leaf updates', () => {
  it('retains independently updated sidebar pages after reopening the database', () => {
    setSettings({ sidebars: { notes: { collapsed: true, width: 360 } } })
    setSettings({ sidebars: { chat: { collapsed: false, width: 320 } } })
    sqlite.close()
    connect()
    expect(getSettings().sidebars).toEqual({
      notes: { collapsed: true, width: 360 },
      chat: { collapsed: false, width: 320 }
    })
  })

  it('retains both dirty budget fields flushed together after a failed daily save and a database reopen', async () => {
    let fail = true
    const updates = createSettingsUpdates({
      initial: getSettings(),
      read: async () => getSettings(),
      publish: () => {},
      write: async (patch) => {
        if (fail) throw new Error('disk full')
        return setSettings(patch)
      }
    })
    const daily = () => updates.update(budgetUpdate({ daily: 25 }))
    await expect(daily()).rejects.toThrow('disk full')
    fail = false
    await Promise.all([daily(), updates.update(budgetUpdate({ monthly: 200 }))])
    sqlite.close()
    connect()
    expect(getSettings().budget).toMatchObject({ perRun: null, daily: 25, monthly: 200 })
  })

  it('does not copy a failed budget leaf from an optimistic preview into a later replacement payload', async () => {
    let reject!: (error: unknown) => void
    let writes = 0
    const updates = createSettingsUpdates({
      initial: getSettings(),
      read: async () => getSettings(),
      publish: () => {},
      write: (patch) =>
        ++writes === 1
          ? new Promise((_, no) => {
              reject = no
            })
          : Promise.resolve(setSettings(patch))
    })
    const daily = updates.update(budgetUpdate({ daily: 25 }))
    const rejected = expect(daily).rejects.toThrow('disk full')
    const monthly = updates.update(budgetUpdate({ monthly: 200 }))
    while (!reject) await Promise.resolve()
    reject(new Error('disk full'))
    await rejected
    await monthly
    expect(getSettings().budget).toMatchObject({ perRun: null, daily: null, monthly: 200 })
  })
  it('merges a review leaf with the current persisted group', () => {
    setSettings({ review: { newPerDay: 30 } } as SettingsPatch)
    expect(getSettings().review).toEqual({ newPerDay: 30, retention: 0.9 })
  })

  it('merges a reflection leaf without dropping the reminder schedule', () => {
    const before = getSettings().reflection
    setSettings({ reflection: { daily: false } } as SettingsPatch)
    expect(getSettings().reflection).toEqual({ ...before, daily: false })
  })

  it('preserves two clients changing different leaves of the same groups across a database reopen', () => {
    // Each client read the same initial snapshot; each sends only the leaf it edited.
    const clientA = getSettings()
    const clientB = getSettings()
    expect(clientA.review).toEqual(clientB.review)
    setSettings({ review: { newPerDay: 50 }, reflection: { weekly: false } } as SettingsPatch)
    setSettings({ review: { retention: 0.95 }, reflection: { time: '08:15' } } as SettingsPatch)
    sqlite.close()
    connect()
    expect(getSettings().review).toEqual({ newPerDay: 50, retention: 0.95 })
    expect(getSettings().reflection).toEqual({ daily: true, weekly: false, weeklyDay: 0, time: '08:15' })
  })

  it('retains complete-payload compatibility and does not mutate a caller patch', () => {
    const patch = {
      review: { newPerDay: 40, retention: 0.85 },
      reflection: { daily: false, weekly: true, weeklyDay: 5, time: '20:30' }
    }
    const original = structuredClone(patch)
    const result = setSettings(patch)
    expect(result.review).toEqual(patch.review)
    expect(result.reflection).toEqual(patch.reflection)
    expect(patch).toEqual(original)
  })

  it('keeps existing partial-group behavior and replaces arrays without recursive merging', () => {
    setSettings({ tasks: { keepRunning: true }, capture: { daily: false }, retrieval: { trustedSites: ['first.example'] } })
    setSettings({ tasks: { launchAtLogin: true }, capture: { time: '09:45' }, retrieval: { trustedSites: [] } })
    const result = getSettings()
    expect(result.tasks).toEqual({ paused: false, launchAtLogin: true, keepRunning: true })
    expect(result.capture).toMatchObject({ daily: false, time: '09:45' })
    expect(result.retrieval.trustedSites).toEqual([])
  })

  it('rolls back every group when a multi-key transaction fails', () => {
    const before = getSettings()
    sqlite.exec(
      "CREATE TRIGGER reject_theme BEFORE INSERT ON settings WHEN NEW.key = 'theme' BEGIN SELECT RAISE(ABORT, 'disk rejected'); END"
    )
    expect(() => setSettings({ review: { newPerDay: 50 }, theme: 'dark' } as SettingsPatch)).toThrow('disk rejected')
    expect(getSettings().review).toEqual(before.review)
    expect(getSettings().theme).toBe(before.theme)
  })
})
