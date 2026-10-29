import { describe, it, expect, vi } from 'vitest'
import { createAutosave } from './autosave'

describe('autosave drafts', () => {
  it('supports existing blur-only fields without introducing a timed save', async () => {
    vi.useFakeTimers()
    try {
      const stored: string[] = []
      const save = createAutosave(
        '',
        async (text) => {
          stored.push(text)
        },
        { delay: false }
      )
      save.change('blur-only')
      await vi.advanceTimersByTimeAsync(1000)
      expect(stored).toEqual([])
      await save.flush()
      expect(stored).toEqual(['blur-only'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('coalesces typing and flushes immediately before a close', async () => {
    vi.useFakeTimers()
    const stored: string[] = []
    const save = createAutosave('', async (text) => {
      stored.push(text)
    })
    save.change('first')
    save.change('last')
    await vi.advanceTimersByTimeAsync(599)
    expect(stored).toEqual([])
    await save.flush()
    expect(stored).toEqual(['last'])
    await vi.advanceTimersByTimeAsync(600)
    expect(stored).toEqual(['last'])
    vi.useRealTimers()
  })
  it('serializes in-flight writes and keeps the newest draft on failure', async () => {
    let release!: () => void
    const stored: string[] = []
    let fail = true
    const save = createAutosave('', async (text) => {
      if (text === 'old')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      if (fail && text === 'new') {
        fail = false
        throw Error('offline')
      }
      stored.push(text)
    })
    save.change('old')
    const first = save.flush()
    while (!release) await Promise.resolve()
    save.change('new')
    const latest = save.flush()
    release()
    await first
    await expect(latest).rejects.toThrow('offline')
    await save.flush()
    expect(stored).toEqual(['old', 'new'])
  })
  it('explicit discard cancels a delayed abandoned draft', async () => {
    vi.useFakeTimers()
    try {
      const stored: string[] = []
      const save = createAutosave('saved', async (value) => {
        stored.push(value)
      })
      save.change('abandoned')
      expect(await save.discard()).toBe('saved')
      await vi.advanceTimersByTimeAsync(1000)
      expect(stored).toEqual([])
      expect(save.dirty).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('discard waits for an in-flight write and cancels only not-yet-started writes', async () => {
    let release!: () => void
    const stored: string[] = []
    const save = createAutosave('saved', async (text) => {
      if (text === 'in flight')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      stored.push(text)
    })
    save.change('in flight')
    const first = save.flush()
    while (!release) await Promise.resolve()
    save.change('queued abandoned')
    const queued = save.flush()
    const discarded = save.discard()
    release()
    await Promise.all([first, queued])
    expect(await discarded).toBe('in flight')
    expect(stored).toEqual(['in flight'])
    expect(save.dirty).toBe(false)
  })
  it('discard does not erase a newer edit made while an earlier write finishes', async () => {
    let release!: () => void
    const stored: string[] = []
    const save = createAutosave('saved', async (text) => {
      if (text === 'in flight')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      stored.push(text)
    })
    save.change('in flight')
    const first = save.flush()
    while (!release) await Promise.resolve()
    const discarded = save.discard()
    save.change('new edit')
    release()
    await first
    expect(await discarded).toBe('new edit')
    expect(save.dirty).toBe(true)
    await save.flush()
    expect(stored).toEqual(['in flight', 'new edit'])
  })
})
