import { emit } from '../events'
import { captureText } from './capture/messages'
import { screenPermissionAction } from './capture/permissions'
import { ClipboardRecency } from './capture/clipboardRecency'
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  nativeImage,
  screen,
  shell,
  systemPreferences
} from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getMainWindow } from '../mainWindow'
import { getSettings } from './settings'
import { getMeta, setMeta } from './memory'
import { importBytes } from './assets'
import { create, accept } from './inbox'
import { recognizeRegionDetailed } from './recognize'
import {
  detailPermission,
  parseForeground,
  ForegroundAppSchema,
  eligibleBrowser,
  collectBrowserOrigin,
  browserProbeScript
} from './capture/foreground'
import type { CaptureState, CaptureDelivery } from '@shared/capture'
import type { InboxOrigin } from '@shared/inbox'
import type { z } from 'zod'
import type { CaptureActionSchema } from '@shared/capture'
const exec = promisify(execFile)
let win: BrowserWindow | null = null,
  state: CaptureState | null = null
let poll: ReturnType<typeof setInterval> | undefined
const recency = new ClipboardRecency()
let shortcuts: string[] = [],
  shortcutErrors: string[] = []
let opening: Promise<void> | null = null
let imageRevision = 0
let contextResolve: ((noteId: string | null) => void) | null = null
let deliveryResolve: ((error: string | null) => void) | null = null
function changed(): void {
  if (state && win && !win.isDestroyed()) win.webContents.send('event:capture:changed', state)
}
export function current(): CaptureState | null {
  return state
}
export function shortcutStatus(): string[] {
  return shortcutErrors
}
async function clipboardImage(): Promise<Electron.NativeImage> {
  for (const item of await clipboard.read())
    if (item.types.includes('image/png')) {
      const blob = await item.getType('image/png')
      return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()))
    }
  return nativeImage.createEmpty()
}
async function fingerprint(): Promise<string> {
  return createHash('sha256')
    .update(await clipboard.readText())
    .update((await clipboardImage()).toPNG())
    .digest('hex')
}
export function registerCapture(): void {
  refreshShortcuts()
  let polling = false
  poll = setInterval(() => {
    if (polling) return
    polling = true
    void fingerprint()
      .then((next) => {
        recency.observe(next)
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false
      })
  }, 1000)
  poll.unref()
}
export function refreshShortcuts(): void {
  shortcuts.forEach((s) => globalShortcut.unregister(s))
  shortcuts = []
  shortcutErrors = []
  const settings = getSettings().capture
  for (const [key, mode] of [
    [settings.quickShortcut, 'text'],
    [settings.screenshotShortcut, 'screenshot'],
    [settings.recordingShortcut, 'recording']
  ] as const) {
    if (!key.trim()) continue
    try {
      if (
        globalShortcut.register(key, () => {
          if (mode === 'recording') {
            const main = getMainWindow()
            if (main?.isMinimized()) main.restore()
            main?.show()
            main?.focus()
            emit('recording:open', undefined)
          } else void open(mode).catch(() => undefined)
        })
      )
        shortcuts.push(key)
      else shortcutErrors.push(key)
    } catch {
      shortcutErrors.push(key)
    }
  }
}
export function stopCapture(): void {
  clearInterval(poll)
  shortcuts.forEach((s) => globalShortcut.unregister(s))
  close()
}
export function close(): void {
  if (win && !win.isDestroyed()) win.close()
}
async function foreground(): Promise<InboxOrigin> {
  if (!getSettings().capture.sourceInfo) return {}
  if (process.platform === 'darwin') {
    let appName: string, browser: 'Google Chrome' | 'Microsoft Edge' | null
    try {
      const raw = (
        await exec(
          '/usr/bin/osascript',
          [
            '-l',
            'JavaScript',
            '-e',
            "ObjC.import('AppKit'); var a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({name:a.localizedName.js,bundleId:a.bundleIdentifier.js})"
          ],
          { timeout: 2000 }
        )
      ).stdout
      const front = ForegroundAppSchema.parse(JSON.parse(raw))
      appName = front.name
      browser = eligibleBrowser(front.bundleId)
    } catch {
      return {}
    }
    const fallback = parseForeground(appName)
    // Safari/Arc 等未提供可验证的隐私状态；不能先读标题再猜测是否无痕。
    if (!browser || !detailPermission(true, getMeta('capture.sourceDenied') === '1')) return fallback
    const target = browser
    try {
      return await collectBrowserOrigin(
        appName,
        async () =>
          JSON.parse((await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', browserProbeScript(target)], { timeout: 2000 })).stdout),
        async (identity) =>
          JSON.parse(
            (
              await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', browserProbeScript(target, true), JSON.stringify(identity)], {
                timeout: 2000
              })
            ).stdout
          ),
        getSettings().browser?.aiBlockedSites ?? []
      )
    } catch {
      setMeta('capture.sourceDenied', '1')
      return fallback
    }
  }
  if (process.platform === 'win32') {
    try {
      // Win32 窗口 API 不能证明浏览器是否无痕；只读取进程名，绝不采集标题。
      const script = `Add-Type @'\nusing System; using System.Runtime.InteropServices; public class Foreground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId); }\n'@\n[uint32]$foregroundProcessId=0; [void][Foreground]::GetWindowThreadProcessId([Foreground]::GetForegroundWindow(),[ref]$foregroundProcessId); (Get-Process -Id $foregroundProcessId).ProcessName`
      return parseForeground(
        (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 2000 })).stdout
      )
    } catch {
      return {}
    }
  }
  return {}
}
export function context(id: string, noteId: string | null, sender: BrowserWindow | null): void {
  if (sender === getMainWindow() && id === state?.id) contextResolve?.(noteId)
}
export function delivered(id: string, error: string | null, sender: BrowserWindow | null): void {
  if (sender === getMainWindow() && id === state?.id) deliveryResolve?.(error)
}
function show(): void {
  if (!state) return
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  win = new BrowserWindow({
    width: 520,
    height: Math.min(620, Math.floor(area.height * 0.8)),
    x: Math.round(area.x + (area.width - 520) / 2),
    y: area.y + Math.round(area.height * 0.13),
    frame: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const currentWindow = win,
    id = state.id
  currentWindow.once('ready-to-show', () => {
    currentWindow.show()
    currentWindow.focus()
  })
  currentWindow.on('blur', () => {
    if (currentWindow.isDestroyed()) return
    // 空白时失焦即关；已有未保存的文字或图片时保留，Esc 或保存后再关
    void currentWindow.webContents
      .executeJavaScript('window.__captureDirty === true')
      .catch(() => false)
      .then((dirty) => {
        if (!dirty && !currentWindow.isDestroyed() && !currentWindow.isFocused()) currentWindow.close()
      })
  })
  currentWindow.on('closed', () => {
    if (win === currentWindow) {
      win = null
      state = null
    }
    getMainWindow()?.webContents.send('event:capture:release', { id })
  })
  currentWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  currentWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) void currentWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?capture=1`)
  else void currentWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { capture: '1' } })
}
async function setImage(bytes: Buffer): Promise<void> {
  if (!state) return
  const revision = ++imageRevision
  const id = state.id,
    image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) throw new Error('capture.invalidImage')
  const png = image.toPNG(),
    asset = await importBytes('capture.png', 'image/png', png)
  if (state?.id !== id || revision !== imageRevision) return
  state.asset = asset
  state.recognition = null
  state.error = null
  state.image = image.toDataURL()
  state.recognitionState = 'pending'
  state.mode = 'screenshot'
  changed()
  void recognizeRegionDetailed(state.image).then((result) => {
    if (state?.id !== id || revision !== imageRevision) return
    state.recognition = result
    state.recognitionState = result ? 'ready' : 'unavailable'
    changed()
  })
}
async function screenshot(): Promise<Buffer | null> {
  if (!app.isPackaged && process.env.JIWEI_CAPTURE_FIXTURE) return readFile(process.env.JIWEI_CAPTURE_FIXTURE)
  if (process.platform === 'darwin') {
    const permission = screenPermissionAction(systemPreferences.getMediaAccessStatus('screen'), getMeta('capture.screenExplained') === '1')
    if (permission === 'deny') throw new Error('capture.screenDenied')
    if (permission === 'explain') {
      setMeta('capture.screenExplained', '1')
      await dialog.showMessageBox({
        type: 'info',
        message: captureText('screenPermission')
      })
    }
    const dir = await mkdtemp(join(tmpdir(), 'jiwei-screen-')),
      path = join(dir, 'capture.png')
    try {
      await exec('/usr/sbin/screencapture', ['-i', '-x', path])
      return await readFile(path).catch(() => null)
    } catch {
      /* 系统截图不可用时使用整屏框选 */
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  if (process.platform === 'win32') {
    const before = createHash('sha256')
      .update((await clipboardImage()).toPNG())
      .digest('hex')
    try {
      await shell.openExternal('ms-screenclip:')
      const until = Date.now() + 15000
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 250))
        const image = await clipboardImage()
        if (!image.isEmpty() && createHash('sha256').update(image.toPNG()).digest('hex') !== before) return image.toPNG()
      }
      return null
    } catch {
      /* 系统工具缺失时走框选后备 */
    }
  }
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted')
    throw new Error('capture.screenDenied')
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor)
    }
  })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('capture.screenDenied')
  if (state) {
    state.mode = 'select'
    state.image = source.thumbnail.toDataURL()
  }
  return null
}
export async function open(mode: 'text' | 'screenshot'): Promise<void> {
  if (opening) return opening
  if (win) {
    win.show()
    win.focus()
    return
  }
  opening = (async () => {
    state = {
      id: randomUUID(),
      mode,
      origin: {},
      asset: null,
      image: null,
      recognition: null,
      recognitionState: 'none',
      clipboard: recency.fresh(),
      targetNoteId: null,
      error: null
    }
    const main = getMainWindow()
    if (main)
      state.targetNoteId = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          contextResolve = null
          resolve(null)
        }, 1000)
        contextResolve = (id) => {
          clearTimeout(timer)
          contextResolve = null
          resolve(id)
        }
        main.webContents.send('event:capture:prepare', { id: state!.id })
      })
    state.origin = await foreground()
    let bytes: Buffer | null = null
    if (mode === 'screenshot') {
      try {
        bytes = await screenshot()
      } catch {
        state.error = 'capture.screenDenied'
        state.mode = 'text'
      }
      if (!bytes && state.mode !== 'select' && !state.error) {
        main?.webContents.send('event:capture:release', { id: state.id })
        state = null
        return
      }
    }
    show()
    if (bytes) await setImage(bytes)
  })()
  try {
    await opening
  } finally {
    opening = null
  }
}
export async function crop(id: string, rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (state?.id !== id || state.mode !== 'select' || !state.image) throw new Error('capture.expired')
  const image = nativeImage.createFromDataURL(state.image),
    size = image.getSize()
  if (rect.x + rect.width > size.width || rect.y + rect.height > size.height) throw new Error('capture.invalidImage')
  await setImage(image.crop(rect).toPNG())
}
export async function attach(id: string, bytes: Uint8Array, name: string, mime: string): Promise<void> {
  if (state?.id !== id) throw new Error('capture.expired')
  if (mime.startsWith('image/')) {
    await setImage(Buffer.from(bytes))
    return
  }
  imageRevision++
  const asset = await importBytes(name, mime, bytes)
  if (state?.id === id) {
    state.asset = asset
    state.image = null
    state.recognition = null
    state.recognitionState = 'none'
    changed()
  }
}
export async function paste(id: string): Promise<string> {
  if (state?.id !== id) throw new Error('capture.expired')
  if (!recency.fresh()) {
    state.clipboard = false
    changed()
    throw new Error('capture.clipboardExpired')
  }
  const image = await clipboardImage()
  if (!image.isEmpty()) await setImage(image.toPNG())
  return (await clipboard.readText()).slice(0, 100000)
}
export async function action(input: z.infer<typeof CaptureActionSchema>): Promise<void> {
  const s = state
  if (!s || s.id !== input.id || (!s.asset && !input.text.trim()) || s.mode === 'select') throw new Error('capture.expired')
  if (input.action === 'save') {
    create({ kind: s.asset ? (s.image ? 'screenshot' : 'file') : 'text', text: input.text, assetId: s.asset?.id, origin: s.origin })
    close()
    return
  }
  const main = getMainWindow()
  if (!main) throw new Error('capture.noNote')
  let sourceId: string | null = null
  if (input.action === 'ask') {
    const item = create({ kind: s.image ? 'screenshot' : 'text', text: input.text, assetId: s.asset?.id, origin: s.origin })
    const filed = await accept(item.id, { action: 'save_source' })
    sourceId = filed.filedTo?.sourceIds?.[0] ?? null
    if (!sourceId) throw new Error('capture.expired')
  }
  const payload: CaptureDelivery = { ...input, action: input.action, image: s.image, asset: s.asset, noteId: s.targetNoteId, sourceId }
  // 等主窗口确认实际插入或创建提问后再关窗；失去目标时原捕捉仍可保存。
  const error = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      deliveryResolve = null
      resolve('capture.noNote')
    }, 15000)
    deliveryResolve = (error) => {
      clearTimeout(timer)
      deliveryResolve = null
      resolve(error)
    }
    main.webContents.send('event:capture:deliver', payload)
  })
  if (error) throw new Error(error)
  close()
  main.show()
  if (main.isMinimized()) main.restore()
  main.focus()
}
