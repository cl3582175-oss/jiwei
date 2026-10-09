import { it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { setMainWindow } from '../mainWindow'
import { requestRendererFlush, resolveFlush } from '../lifecycle'
it('only the registered main window can acknowledge its pending document flush', async () => {
  const send = vi.fn(),
    main = { isDestroyed: () => false, once: vi.fn(), webContents: { send } } as unknown as BrowserWindow
  const capture = { isDestroyed: () => false } as BrowserWindow
  setMainWindow(main)
  let done = false
  const pending = requestRendererFlush(1000).then(() => {
    done = true
  })
  expect(send).toHaveBeenCalledWith('event:app:flush')
  resolveFlush(capture)
  await Promise.resolve()
  expect(done).toBe(false)
  resolveFlush(main)
  await pending
  expect(done).toBe(true)
})
