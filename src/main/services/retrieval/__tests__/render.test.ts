import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import * as schema from '../../../db/knowledgeSchema'
interface FakeWindow {
  options: Record<string, unknown>
  destroyed: boolean
  destroy(): void
  webContents: EventEmitter & {
    id: number
    currentUrl: string
    getURL(): string
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    executeJavaScript: ReturnType<typeof vi.fn>
  }
}
type Before = (
  details: { url: string; resourceType: string; webContentsId: number },
  callback: (result: { cancel: boolean }) => void
) => void
const state = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  app: null as EventEmitter | null,
  session: null as EventEmitter | null,
  windows: [] as FakeWindow[],
  before: null as Before | null,
  permission: null as ((a: unknown, b: unknown, c: (v: boolean) => void) => void) | null,
  proxy: vi.fn(),
  clear: vi.fn(),
  execute: vi.fn(),
  autoFinish: true,
  partitions: [] as string[]
}))
vi.mock('../../../db', () => ({ getDb: () => state.db, getSqlite: () => state.sqlite }))
vi.mock('../../settings', () => ({ getSettings: () => ({ browser: { aiBlockedSites: [] } }) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getLocale: () => 'en' })
  state.app = app
  const s = Object.assign(new EventEmitter(), {
    setProxy: state.proxy,
    clearStorageData: state.clear,
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: (fn: typeof state.permission) => {
      state.permission = fn
    },
    webRequest: {
      onBeforeRequest: (fn: Before) => {
        state.before = fn
      }
    }
  })
  state.session = s
  class Window extends EventEmitter {
    destroyed = false
    private contents = Object.assign(new EventEmitter(), {
      id: state.windows.length + 1,
      currentUrl: '',
      getURL: () => this.contents.currentUrl,
      setWindowOpenHandler: vi.fn(),
      stop: vi.fn(),
      executeJavaScript: state.execute,
      isDestroyed: () => this.destroyed
    })
    get webContents(): typeof this.contents {
      if (this.destroyed) throw new Error('WebContents is destroyed')
      return this.contents
    }
    constructor(readonly options: Record<string, unknown>) {
      super()
      state.windows.push(this)
    }
    async loadURL(url: string): Promise<void> {
      this.webContents.currentUrl = url
      if (state.autoFinish) queueMicrotask(() => this.webContents.emit('did-finish-load'))
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
      this.contents.emit('destroyed')
      this.emit('closed')
    }
  }
  return {
    app,
    BrowserWindow: Window,
    session: {
      fromPartition: (name: string) => {
        state.partitions.push(name)
        return s
      }
    }
  }
})
let renderPage: typeof import('../render').renderPage
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  state.sqlite = new Database(':memory:')
  state.sqlite.loadExtension(getLoadablePath())
  state.db = drizzle(state.sqlite, { schema })
  migrate(state.db, { migrationsFolder: 'resources/migrations' })
  state.windows = []
  state.partitions = []
  state.before = null
  state.permission = null
  state.autoFinish = true
  state.proxy.mockReset().mockResolvedValue(undefined)
  state.clear.mockReset().mockResolvedValue(undefined)
  state.execute.mockReset().mockResolvedValue('<html><body>Rendered snapshot.</body></html>')
  const { setMessageLanguage } = await import('../../../lib/messages')
  setMessageLanguage('en')
  renderPage = (await import('../render')).renderPage
})
afterEach(async () => {
  state.app?.emit('before-quit')
  await vi.advanceTimersByTimeAsync(0)
  state.sqlite?.close()
  state.db = null
  state.sqlite = null
  vi.useRealTimers()
})
const start = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}
const request = (url: string, type: string, id: number): boolean => {
  let canceled = false
  state.before!({ url, resourceType: type, webContentsId: id }, (r) => {
    canceled = r.cancel
  })
  return canceled
}
describe('sandbox renderer lifecycle', () => {
  it('configures a memory-only system-proxy sandbox, waits1500ms, captures DOM and cleans the window/storage', async () => {
    const pending = renderPage('https://example.org/article')
    await start()
    expect(state.partitions).toEqual(['jiwei-reader'])
    expect(state.proxy).toHaveBeenCalledWith({ mode: 'system' })
    const w = state.windows[0]
    expect(w.options).toMatchObject({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, images: false }
    })
    expect(w.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    let permission = true
    state.permission!(null, null, (allowed) => {
      permission = allowed
    })
    expect(permission).toBe(false)
    const event = { preventDefault: vi.fn() }
    state.session!.emit('will-download', event)
    expect(event.preventDefault).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1499)
    expect(state.execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ html: '<html><body>Rendered snapshot.</body></html>', finalUrl: 'https://example.org/article' })
    expect(state.execute).toHaveBeenCalledWith('document.documentElement.outerHTML', true)
    expect(w.destroyed).toBe(true)
    expect(state.clear).toHaveBeenCalledTimes(1)
  })
  it('creates at most two windows and starts the queued third only after cleanup releases a slot', async () => {
    const tasks = [1, 2, 3].map((i) => renderPage('https://example.org/article-' + i))
    await start()
    expect(state.windows).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(state.windows).toHaveLength(3)
    expect(state.windows.filter((w) => !w.destroyed)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1500)
    await Promise.all(tasks)
    expect(state.windows.every((w) => w.destroyed)).toBe(true)
    expect(state.clear).toHaveBeenCalledTimes(3)
  })
  it('blocks heavy/nonHTTP/private/sensitive/SERP resources while allowing ordinary public CSS/JS without whitelist approval', async () => {
    const guard = vi.fn((url: string) => {
      if (url !== 'https://example.org/article') throw new Error('private-query')
    })
    const pending = renderPage('https://example.org/article', { validateUrl: guard })
    await start()
    const id = state.windows[0].webContents.id
    guard.mockClear()
    for (const [url, type] of [
      ['https://example.org/image', 'image'],
      ['https://example.org/audio', 'media'],
      ['https://example.org/font', 'font'],
      ['file:///tmp/private', 'script'],
      ['https://127.0.0.1/private', 'script'],
      ['https://mail.example.org/inbox', 'xhr'],
      ['https://www.google.com/search?q=x', 'script']
    ])
      expect(request(url, type, id)).toBe(true)
    expect(request('https://cdn.example.org/style.css', 'stylesheet', id)).toBe(false)
    expect(request('https://cdn.example.org/app.js', 'script', id)).toBe(false)
    expect(guard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    await pending
  })
  it('refuses a main navigation whitelist violation and destroys its window', async () => {
    state.autoFinish = false
    const pending = renderPage('https://example.org/article', {
      validateUrl: (url) => {
        if (url.includes('/private')) throw new Error('private-query synthetic-key')
      }
    }).catch((e: unknown) => e)
    await start()
    const event = { preventDefault: vi.fn() }
    state.windows[0].webContents.emit('will-navigate', event, 'https://example.org/private')
    const error = await pending
    expect(event.preventDefault).toHaveBeenCalled()
    expect(String(error)).not.toMatch(/private-query|synthetic-key/)
    expect(state.windows[0].destroyed).toBe(true)
    expect(state.clear).toHaveBeenCalled()
  })
  it('removes an aborted queued request without creating its window', async () => {
    state.autoFinish = false
    const first = renderPage('https://example.org/one'),
      second = renderPage('https://example.org/two')
    const c = new AbortController()
    const queued = renderPage('https://example.org/three', { signal: c.signal }).catch((e: unknown) => e)
    await start()
    c.abort('private-query')
    expect(String(await queued)).not.toContain('private-query')
    expect(state.windows).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(20000)
    await Promise.all([first, second])
    expect(state.windows).toHaveLength(2)
  })
  it('uses current DOM at20s timeout and bounds an unresponsive DOM IPC', async () => {
    state.autoFinish = false
    const pending = renderPage('https://example.org/article')
    await start()
    await vi.advanceTimersByTimeAsync(20000)
    expect((await pending).html).toContain('Rendered snapshot')
    expect(state.windows[0].destroyed).toBe(true)
    state.execute.mockImplementation(() => new Promise(() => {}))
    const failure = renderPage('https://example.org/hang').catch((e: unknown) => e)
    await start()
    await vi.advanceTimersByTimeAsync(21000)
    expect(await failure).toBeInstanceOf(Error)
    expect(state.windows[1].destroyed).toBe(true)
  })
  it('cleans an active window on cancellation and on application quit', async () => {
    state.autoFinish = false
    const c = new AbortController(),
      pending = renderPage('https://example.org/article', { signal: c.signal }).catch((e: unknown) => e)
    await start()
    c.abort('private-query synthetic-key')
    expect(String(await pending)).not.toMatch(/private-query|synthetic-key/)
    expect(state.windows[0].destroyed).toBe(true)
    const quit = renderPage('https://example.org/other').catch((e: unknown) => e)
    await start()
    state.app!.emit('before-quit')
    expect(await quit).toBeInstanceOf(Error)
    expect(state.windows[1].destroyed).toBe(true)
    expect(state.clear).toHaveBeenCalledTimes(2)
  })
  it('cleans both active sessions and cancels queued work when quit invalidates window webContents access', async () => {
    state.autoFinish = false
    const tasks = [1, 2, 3].map((i) => renderPage('https://example.org/quit-' + i).catch((e: unknown) => e))
    await start()
    expect(state.windows).toHaveLength(2)
    const contents = state.windows.map((w) => w.webContents)
    state.app!.emit('before-quit')
    const errors = await Promise.all(tasks)
    expect(errors.every((error) => error instanceof Error && /Reading canceled/.test(String(error)))).toBe(true)
    expect(state.windows).toHaveLength(2)
    expect(state.windows.every((w) => w.destroyed)).toBe(true)
    expect(state.clear).toHaveBeenCalledTimes(2)
    for (const content of contents) expect(request('https://example.org/quit-late', 'mainFrame', content.id)).toBe(true)
  })
  it('cleans storage even when DOM execution fails', async () => {
    state.execute.mockRejectedValue(new Error('private-query synthetic-key'))
    const pending = renderPage('https://example.org/article').catch((e: unknown) => e)
    await start()
    await vi.advanceTimersByTimeAsync(1500)
    expect(String(await pending)).not.toMatch(/private-query|synthetic-key/)
    expect(state.windows[0].destroyed).toBe(true)
    expect(state.clear).toHaveBeenCalled()
  })
  it('refuses SERP before creating a browser window', async () => {
    await expect(renderPage('https://www.baidu.com/s?wd=private')).rejects.toThrow()
    expect(state.windows).toHaveLength(0)
  })
})
