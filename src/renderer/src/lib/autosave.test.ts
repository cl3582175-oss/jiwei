import { describe, it, expect, vi } from 'vitest'
import { createAutosave } from './autosave'

describe('autosave drafts', () => {
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
})
