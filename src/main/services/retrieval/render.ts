import { app, BrowserWindow, session, type Session } from 'electron'
import { tr } from '../../lib/messages'
import { assertReadableUrl, PagePolicyError } from './pagePolicy'

export interface RenderOptions {
  signal?: AbortSignal
  validateUrl?: (url: string) => void
}
class RenderError extends Error {
  constructor(kind: 'failed' | 'canceled' | 'timeout' | 'scope' | 'cleanup') {
    const words = {
      failed: ['网页渲染失败', 'Page rendering failed'],
      canceled: ['读取已取消', 'Reading canceled'],
      timeout: ['网页渲染超时', 'Page rendering timed out'],
      scope: ['这个网址不在允许读取的范围内', 'This address is outside the allowed reading scope'],
      cleanup: ['网页临时会话清理失败', 'Temporary page session cleanup failed']
    } as const
    const message = words[kind]
    super(tr(message[0], message[1]))
    this.name = 'RenderError'
  }
}
const windows = new Set<BrowserWindow>()
const scopes = new Map<number, { validate: (url: string) => void; fail: (error: Error) => void }>()
const quitting = new AbortController()
let ready: Promise<Session> | null = null,
  broken = false,
  active = 0
type Waiter = { signal: AbortSignal; grant: () => void; reject: (error: Error) => void; cleanup: () => void }
const waiting: Waiter[] = []
app.once('before-quit', () => {
  quitting.abort()
  for (const win of windows) if (!win.isDestroyed()) win.destroy()
})
function acquire(signal: AbortSignal, deadline: number): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new RenderError('canceled'))
  const release = (): void => {
    active--
    while (waiting.length) {
      const next = waiting.shift()!
      next.cleanup()
      if (next.signal.aborted) {
        next.reject(new RenderError('canceled'))
        continue
      }
      next.grant()
      break
    }
  }
  const permit = (): (() => void) => {
    active++
    let done = false
    return () => {
      if (!done) {
        done = true
        release()
      }
    }
  }
  if (active < 2) return Promise.resolve(permit())
  return new Promise((resolve, reject) => {
    const remove = (error: Error): void => {
      const index = waiting.indexOf(entry)
      if (index >= 0) waiting.splice(index, 1)
      entry.cleanup()
      reject(error)
    }
    const abort = (): void => remove(new RenderError('canceled'))
    const timer = setTimeout(() => remove(new RenderError('timeout')), Math.max(0, deadline - Date.now()))
    const entry: Waiter = {
      signal,
      grant: () => resolve(permit()),
      reject,
      cleanup: () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    waiting.push(entry)
  })
}
function bounded<T>(promise: Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      reject(new RenderError('canceled'))
    }
    const timer = setTimeout(
      () => {
        cleanup()
        reject(new RenderError('timeout'))
      },
      Math.max(0, timeout)
    )
    signal?.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal?.aborted) abort()
  })
}
function getSession(): Promise<Session> {
  if (broken) return Promise.reject(new RenderError('cleanup'))
  if (ready) return ready
  const s = session.fromPartition('jiwei-reader')
  s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  s.setPermissionCheckHandler(() => false)
  s.on('will-download', (event) => event.preventDefault())
  s.webRequest.onBeforeRequest((details, callback) => {
    if (['image', 'media', 'font'].includes(details.resourceType)) {
      callback({ cancel: true })
      return
    }
    const scope = details.webContentsId === undefined ? undefined : scopes.get(details.webContentsId)
    try {
      assertReadableUrl(details.url)
      if (details.resourceType === 'mainFrame') {
        if (!scope) throw new RenderError('scope')
        scope.validate(details.url)
      }
      callback({ cancel: false })
    } catch (error) {
      if (details.resourceType === 'mainFrame') scope?.fail(error instanceof PagePolicyError ? error : new RenderError('scope'))
      callback({ cancel: true })
    }
  })
  ready = s.setProxy({ mode: 'system' }).then(() => s)
  return ready
}
export async function renderPage(url: string, opts: RenderOptions = {}): Promise<{ html: string; finalUrl: string }> {
  const validate = (target: string): void => {
    assertReadableUrl(target)
    try {
      opts.validateUrl?.(target)
    } catch {
      throw new RenderError('scope')
    }
  }
  validate(url)
  const signal = opts.signal ? AbortSignal.any([opts.signal, quitting.signal]) : quitting.signal
  const deadline = Date.now() + 20000,
    release = await acquire(signal, deadline)
  let win: BrowserWindow | undefined, s: Session | undefined
  let contentsId: number | undefined
  let finish: ((error?: Error) => void) | undefined
  try {
    s = await bounded(getSession(), deadline - Date.now(), signal)
    if (signal.aborted) throw new RenderError('canceled')
    if (Date.now() >= deadline) throw new RenderError('timeout')
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        images: false,
        session: s
      }
    })
    windows.add(win)
    const contents = win.webContents
    contentsId = contents.id
    const refuse = (error: Error): void => {
      contents.stop()
      finish?.(error)
    }
    scopes.set(contents.id, { validate, fail: refuse })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const navigate = (event: { preventDefault(): void }, target: string): void => {
      try {
        validate(target)
      } catch (error) {
        event.preventDefault()
        refuse(error instanceof PagePolicyError ? error : new RenderError('scope'))
      }
    }
    contents.on('will-navigate', navigate)
    contents.on('will-redirect', navigate)
    await new Promise<void>((resolve, reject) => {
      let settled = false,
        delay: ReturnType<typeof setTimeout> | undefined
      const complete = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (delay) clearTimeout(delay)
        signal.removeEventListener('abort', abort)
        contents.removeListener('did-finish-load', loaded)
        if (error) reject(error)
        else resolve()
      }
      const abort = (): void => complete(new RenderError('canceled'))
      const loaded = (): void => {
        if (delay) clearTimeout(delay)
        delay = setTimeout(() => complete(), Math.min(1500, Math.max(0, deadline - Date.now())))
      }
      const timer = setTimeout(() => complete(), Math.max(0, deadline - Date.now()))
      finish = complete
      signal.addEventListener('abort', abort, { once: true })
      contents.on('did-finish-load', loaded)
      // 失败的加载仍可能留下可读DOM；只等待到总deadline，不做登录/验证交互。
      void win!.loadURL(url).catch(() => {})
      if (signal.aborted) abort()
    })
    if (signal.aborted) throw new RenderError('canceled')
    validate(contents.getURL() || url)
    // deadline时也读已加载内容；DOM IPC本身另有1秒有界完成时间，防止渲染进程无响应。
    const html = await bounded(contents.executeJavaScript('document.documentElement.outerHTML', true), 1000, signal)
    if (typeof html !== 'string') throw new RenderError('failed')
    return { html, finalUrl: contents.getURL() || url }
  } catch (error) {
    if (signal.aborted) throw new RenderError('canceled')
    if (error instanceof PagePolicyError || error instanceof RenderError) throw error
    throw new RenderError('failed')
  } finally {
    try {
      if (contentsId !== undefined) scopes.delete(contentsId)
      if (win) {
        windows.delete(win)
        if (!win.isDestroyed()) win.destroy()
      }
    } finally {
      try {
        if (s)
          try {
            await bounded(s.clearStorageData(), 2000)
          } catch {
            broken = true
            // 隐私清理失败必须覆盖已产生的结果，避免返回无法安全清理的渲染会话。
            // eslint-disable-next-line no-unsafe-finally
            throw new RenderError('cleanup')
          }
      } finally {
        release()
      }
    }
  }
}
