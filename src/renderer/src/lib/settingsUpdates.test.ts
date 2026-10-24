import { describe, expect, it } from 'vitest'
import type { Settings } from '@shared/types'
import { captureDefaults } from '@shared/capture'
import { DEFAULT_BUDGET, DEFAULT_MCP_PORT } from '@shared/agent'
import { DEFAULT_PODCAST_VOICE } from '@shared/discover'
import { defaultMoney } from '@shared/money'
import { RETRIEVAL_DEFAULTS } from '@shared/retrieval'
import { UI_DEFAULTS } from '@shared/ui/settings'
import { applySettingsPatch, createSettingsUpdates } from './settingsUpdates'

const initial = (): Settings => ({
  theme: 'system',
  palette: 'qinglu',
  language: 'zh-CN',
  onboarded: true,
  sidebarCollapsed: false,
  plugins: { recommendedDismissed: false },
  plan: { autoComplete: true },
  capture: captureDefaults(true),
  discover: { dailyLimit: 5, dailyBudget: 1, budgetCurrency: 'CNY', useSearch: true, podcast: false, podcastVoice: DEFAULT_PODCAST_VOICE },
  ai: {
    ui: UI_DEFAULTS,
    chat: { providerId: null, model: null },
    effort: 'high',
    embedding: { mode: 'local', providerId: null, model: null }
  },
  budget: DEFAULT_BUDGET,
  money: defaultMoney(),
  mcpServe: { enabled: false, port: DEFAULT_MCP_PORT },
  review: { newPerDay: 20, retention: 0.9 },
  reflection: { daily: true, weekly: true, weeklyDay: 0, time: '21:00' },
  tasks: { paused: false, launchAtLogin: false, keepRunning: false },
  retrieval: { ...RETRIEVAL_DEFAULTS, trustedSites: ['old.example'], lowTrustSites: [] },
  browser: { aiBlockedSites: ['old.example'], noteSide: 'right' }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function started(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('settings update coordination', () => {
  it('retains separate sidebar page preferences when a sparse page record is previewed', () => {
    const notes = applySettingsPatch(initial(), { sidebars: { notes: { collapsed: true, width: 360 } } })
    const chat = applySettingsPatch(notes, { sidebars: { chat: { collapsed: false, width: 320 } } })
    expect(chat.sidebars).toEqual({
      notes: { collapsed: true, width: 360 },
      chat: { collapsed: false, width: 320 }
    })
  })

  it('replays queued leaf patches in order without replacing sibling fields', async () => {
    let stored = initial()
    const first = deferred<Settings>()
    let writes = 0
    const updates = createSettingsUpdates({
      initial: stored,
      read: async () => stored,
      write: async (patch) => {
        if (++writes === 1) return first.promise
        stored = { ...stored, review: { ...stored.review, ...patch.review } }
        return stored
      },
      publish: () => {}
    })
    const a = updates.update({ review: { newPerDay: 30 } })
    const b = updates.update({ review: { retention: 0.95 } })
    expect(updates.snapshot?.review).toEqual({ newPerDay: 30, retention: 0.95 })
    await started()
    expect(writes).toBe(1)
    stored = { ...stored, review: { newPerDay: 30, retention: 0.9 } }
    first.resolve(stored)
    await Promise.all([a, b])
    expect(updates.snapshot?.review).toEqual({ newPerDay: 30, retention: 0.95 })
    expect(stored.review).toEqual({ newPerDay: 30, retention: 0.95 })
  })

  it('serializes same-field writes while rendering the latest pending value', async () => {
    const first = deferred<Settings>()
    const second = deferred<Settings>()
    let writes = 0
    const updates = createSettingsUpdates({
      initial: initial(),
      read: async () => initial(),
      write: () => (++writes === 1 ? first.promise : second.promise),
      publish: () => {}
    })
    const a = updates.update({ theme: 'light' })
    const b = updates.update({ theme: 'dark' })
    await started()
    expect(writes).toBe(1)
    expect(updates.snapshot?.theme).toBe('dark')
    first.resolve({ ...initial(), theme: 'light' })
    await a
    await started()
    expect(writes).toBe(2)
    expect(updates.snapshot?.theme).toBe('dark')
    second.resolve({ ...initial(), theme: 'dark' })
    await b
    expect(updates.snapshot?.theme).toBe('dark')
  })

  it('does not let an older broadcast read erase a local pending leaf', async () => {
    const oldRead = deferred<Settings>()
    let published = initial()
    const updates = createSettingsUpdates({
      initial: initial(),
      read: () => oldRead.promise,
      write: async () => ({ ...initial(), review: { newPerDay: 50, retention: 0.95 } }),
      publish: (value) => {
        published = value
      }
    })
    const refresh = updates.refresh()
    await started()
    const save = updates.update({ review: { newPerDay: 50 } })
    oldRead.resolve({ ...initial(), review: { newPerDay: 20, retention: 0.95 } })
    await refresh
    expect(published.review).toEqual({ newPerDay: 50, retention: 0.95 })
    await save
    expect(published.review).toEqual({ newPerDay: 50, retention: 0.95 })
  })

  it('removes only a failed patch and refreshes real values beneath a newer optimistic patch', async () => {
    const oldWrite = deferred<Settings>()
    let reads = 0
    let writes = 0
    const confirmed = { ...initial(), review: { newPerDay: 20, retention: 0.85 } }
    const updates = createSettingsUpdates({
      initial: initial(),
      read: async () => {
        reads++
        return confirmed
      },
      write: async () => {
        if (++writes === 1) return oldWrite.promise
        return { ...confirmed, review: { ...confirmed.review, newPerDay: 50 } }
      },
      publish: () => {}
    })
    const older = updates.update({ review: { newPerDay: 30 } })
    const rejected = expect(older).rejects.toThrow('disk full')
    const newer = updates.update({ review: { newPerDay: 50 } })
    oldWrite.reject(new Error('disk full'))
    await rejected
    expect(updates.snapshot?.review).toEqual({ newPerDay: 50, retention: 0.85 })
    await newer
    expect(reads).toBe(1)
    expect(updates.snapshot?.review).toEqual({ newPerDay: 50, retention: 0.85 })
  })

  it('waits for every current write and reports failure without poisoning a later retry', async () => {
    let fail = true
    const updates = createSettingsUpdates({
      initial: initial(),
      read: async () => initial(),
      write: async () => {
        if (fail) throw new Error('offline')
        return { ...initial(), theme: 'dark' }
      },
      publish: () => {}
    })
    const rejected = expect(updates.update({ theme: 'dark' })).rejects.toThrow('offline')
    await expect(updates.flush()).rejects.toThrow('offline')
    await rejected
    expect(updates.snapshot?.theme).toBe('system')
    fail = false
    await updates.update({ theme: 'dark' })
    await expect(updates.flush()).resolves.toBeUndefined()
    expect(updates.snapshot?.theme).toBe('dark')
  })

  it('keeps arrays and groups with replacement semantics intact', () => {
    expect(applySettingsPatch(initial(), { retrieval: { trustedSites: [] } }).retrieval.trustedSites).toEqual([])
    expect(applySettingsPatch(initial(), { browser: { aiBlockedSites: [] } }).browser).toEqual({ aiBlockedSites: [] })
  })
})
