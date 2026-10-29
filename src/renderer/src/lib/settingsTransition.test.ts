import { describe, expect, it } from 'vitest'
import { createSettingsTransition } from './settingsTransition'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('settings leave barrier', () => {
  it('keeps the current group mounted until registered persistence finishes', async () => {
    const save = deferred()
    const transition = createSettingsTransition()
    let current = 'profile'
    transition.register('profile.role', { dirty: () => true, flush: () => save.promise })
    const leaving = transition.request('tab:general', () => {
      current = 'general'
    })
    expect(transition.getSnapshot().pending).toBe(true)
    expect(current).toBe('profile')
    save.resolve()
    expect(await leaving).toBe(true)
    expect(current).toBe('general')
    expect(transition.getSnapshot().pending).toBe(false)
  })

  it('retains a failed draft and leave intent for retry', async () => {
    const transition = createSettingsTransition()
    let fail = true
    let draft = 'unsaved'
    let stored = ''
    let open = true
    transition.register('profile.role', {
      dirty: () => draft !== stored,
      flush: async () => {
        if (fail) throw new Error('disk full')
        stored = draft
      }
    })
    expect(
      await transition.request('close', () => {
        open = false
      })
    ).toBe(false)
    expect(open).toBe(true)
    expect(draft).toBe('unsaved')
    expect(transition.getSnapshot().error).toBeInstanceOf(Error)
    fail = false
    draft = 'unsaved'
    expect(await transition.retry()).toBe(true)
    expect(stored).toBe('unsaved')
    expect(open).toBe(false)
  })

  it('validates before saving or leaving and allows continued editing', async () => {
    const transition = createSettingsTransition()
    let flushes = 0
    let left = false
    transition.register('profile.goals', {
      dirty: () => true,
      validate: () => 'over limit',
      flush: async () => {
        flushes++
      }
    })
    expect(
      await transition.request('close', () => {
        left = true
      })
    ).toBe(false)
    expect(left).toBe(false)
    expect(flushes).toBe(0)
    transition.continueEditing()
    expect(transition.getSnapshot()).toMatchObject({ pending: false, error: null })
    expect(await transition.retry()).toBe(false)
  })

  it('coalesces repeated leave requests and commits only the most recent target', async () => {
    const save = deferred()
    const transition = createSettingsTransition()
    let flushes = 0
    const destinations: string[] = []
    transition.register('profile.role', {
      dirty: () => true,
      flush: async () => {
        flushes++
        await save.promise
      }
    })
    const first = transition.request('close', () => {
      destinations.push('close')
    })
    const duplicate = transition.request('close', () => {
      destinations.push('duplicate')
    })
    const latest = transition.request('usage', () => {
      destinations.push('usage')
    })
    expect(first).toBe(duplicate)
    expect(first).toBe(latest)
    save.resolve()
    await first
    expect(flushes).toBe(1)
    expect(destinations).toEqual(['usage'])
  })

  it('discards only after an explicit decision and does not flush the abandoned draft', async () => {
    const transition = createSettingsTransition()
    let draft = 'over limit'
    let flushes = 0
    let left = false
    transition.register('profile.role', {
      dirty: () => true,
      validate: () => 'invalid',
      flush: async () => {
        flushes++
      },
      discard: () => {
        draft = ''
      }
    })
    expect(
      await transition.request('close', () => {
        left = true
      })
    ).toBe(false)
    expect(left).toBe(false)
    expect(await transition.discard()).toBe(true)
    expect(draft).toBe('')
    expect(flushes).toBe(0)
    expect(left).toBe(true)
  })

  it('waits for all active flushes after one fails before unlocking fields', async () => {
    const saving = deferred()
    const transition = createSettingsTransition()
    transition.register('failed', {
      dirty: () => true,
      flush: async () => {
        throw new Error('fail')
      }
    })
    transition.register('slow', { dirty: () => true, flush: () => saving.promise })
    const leaving = transition.request('close', () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(transition.getSnapshot().pending).toBe(true)
    saving.resolve()
    expect(await leaving).toBe(false)
    expect(transition.getSnapshot().pending).toBe(false)
  })
})
