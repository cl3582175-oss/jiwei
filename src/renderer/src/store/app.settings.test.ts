import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsTransition } from '../lib/settingsTransition'
import { useApp } from './app'

let unregister: (() => void) | undefined
beforeEach(() => {
  vi.stubGlobal('window', { dispatchEvent: () => true })
  settingsTransition.continueEditing()
  useApp.setState({ settingsOpen: true, settingsTab: 'me', view: 'today', modelSetupOpen: false })
})
afterEach(() => {
  unregister?.()
  unregister = undefined
  settingsTransition.continueEditing()
  vi.unstubAllGlobals()
})

describe('settings store leave entries', () => {
  it('does not directly close settings before the registered save finishes', async () => {
    let release!: () => void
    unregister = settingsTransition.register('test', {
      dirty: () => true,
      flush: () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    })
    const closed = useApp.getState().setSettingsOpen(false)
    expect(useApp.getState().settingsOpen).toBe(true)
    while (!release) await Promise.resolve()
    release()
    await closed
    expect(useApp.getState().settingsOpen).toBe(false)
  })

  it('keeps settings and the current route on a failed usage navigation, then retries the same destination', async () => {
    let fail = true
    unregister = settingsTransition.register('test', {
      dirty: () => true,
      flush: async () => {
        if (fail) throw new Error('offline')
      }
    })
    await useApp.getState().openUsage()
    expect(useApp.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'me', view: 'today' })
    fail = false
    await settingsTransition.retry()
    expect(useApp.getState()).toMatchObject({ settingsOpen: false, view: 'usage' })
  })

  it('waits before external settings-tab and model-setup requests can replace a dirty group', async () => {
    unregister = settingsTransition.register('test', { dirty: () => true, validate: () => 'invalid draft', flush: async () => {} })
    await useApp.getState().openSettings('ai')
    expect(useApp.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'me', modelSetupOpen: false })
    await useApp.getState().openModelSetup()
    expect(useApp.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'me', modelSetupOpen: false })
    unregister()
    unregister = undefined
    await settingsTransition.retry()
    expect(useApp.getState()).toMatchObject({ settingsOpen: false, modelSetupOpen: true })
  })

  it('routes ordinary navigation through the same barrier', async () => {
    unregister = settingsTransition.register('test', { dirty: () => true, validate: () => 'invalid', flush: async () => {} })
    useApp.getState().setView('notes')
    await Promise.resolve()
    await Promise.resolve()
    expect(useApp.getState()).toMatchObject({ settingsOpen: true, view: 'today' })
  })
})
