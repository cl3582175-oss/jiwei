import { beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ sent: [] as { channel: string; payload: unknown }[] }))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => transport.sent.push({ channel, payload }) }
      }
    ]
  }
}))
vi.mock('electron-log/main', () => ({ default: { warn: () => {} } }))

import { emit, onMainEvent } from '../events'

beforeEach(() => {
  transport.sent = []
})

describe('main process event notifications', () => {
  it('notifies matching subscribers for ordinary and batched memory changes, and supports removal', () => {
    let refreshes = 0
    const off = onMainEvent('memory:changed', () => {
      refreshes++
    })
    emit('browser:state', { tabs: [], activeId: null })
    expect(refreshes).toBe(0)
    emit('memory:changed', {})
    emit('memory:changed', { learned: [] })
    expect(refreshes).toBe(2)
    expect(transport.sent.at(-1)).toEqual({ channel: 'event:memory:changed', payload: { learned: [] } })
    off()
    emit('memory:changed', {})
    expect(refreshes).toBe(2)
  })

  it('keeps the original notification and other subscribers working if a listener fails', () => {
    const stopBroken = onMainEvent('memory:changed', () => {
      throw new Error('refresh unavailable')
    })
    let refreshed = false
    const stopHealthy = onMainEvent('memory:changed', () => {
      refreshed = true
    })
    expect(() => emit('memory:changed', {})).not.toThrow()
    expect(refreshed).toBe(true)
    expect(transport.sent).toEqual([{ channel: 'event:memory:changed', payload: {} }])
    stopBroken()
    stopHealthy()
  })
})
