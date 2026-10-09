import { join } from 'path'
import { app, BrowserWindow, WebContentsView, ipcMain, session, shell, type Session, type WebContents } from 'electron'
import log from 'electron-log/main'
import { newId } from '../../lib/ids'
import { emit } from '../../events'
import type { BrowserState, BrowserTab } from '@shared/types'
import { isSensitiveUrl } from '../../lib/browserPolicy'
import { getSettings } from '../settings'

// 内置浏览器（v0.6.0，设计见 docs/design/v0.6-browser-and-capture.md §3.1）：
//   - 每个标签页是一个 WebContentsView（Electron 推荐的嵌入方式），叠放在工作区左栏的占位区域上
//   - 网页在沙箱中运行，上下文隔离；独立的持久会话（登录状态保留，与积微本身隔离）；无痕标签用临时会话
//   - 内容脚本（preload/browser.ts）运行在隔离环境中：选区浮条、高亮、读取正文；网页本身拿不到任何积微接口
//   - 敏感页面（网银、支付、邮箱、密码输入）自动关闭 AI

const PARTITION = 'persist:jiwei-browser'
const HOME = 'about:blank'

interface Tab {
  id: string
  view: WebContentsView
  incognito: boolean
  /** 页面中出现了密码输入框（内容脚本报告） */
  hasPassword: boolean
  /** 已存为资料（同一网址复用） */
  sourceId: string | null
  /** 打开时间与互动次数（离开时的回顾） */
  openedAt: number
  interactions: number
  favicon: string | null
}

const tabs = new Map<string, Tab>()
let order: string[] = []
let activeId: string | null = null
let host: BrowserWindow | null = null
let bounds: { x: number; y: number; width: number; height: number } | null = null
let visible = false
let incognitoSeq = 0

/* ——— 会话：浏览器式 UA、权限、下载 ——— */

const configured = new WeakSet<Session>()
type DownloadHandler = (path: string, name: string) => void
let onDownload: DownloadHandler | null = null
export function setDownloadHandler(fn: DownloadHandler): void {
  onDownload = fn
}

/** 去掉 UA 中的 Electron 与应用名（部分网站据此拒绝访问） */
const browserUA = (): string => app.userAgentFallback.replace(/\s(Electron|jiwei|积微)\/\S+/gi, '')

function setupSession(ses: Session): void {
  if (configured.has(ses)) return
  configured.add(ses)
  ses.setUserAgent(browserUA())
  // 只允许少数无害的权限；摄像头、麦克风、定位、通知等一律拒绝
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  ses.on('will-download', (_e, item) => {
    const name = item.getFilename()
    // 端到端测试：开发构建可指定下载目录
    const dir = (!app.isPackaged && process.env.JIWEI_DOWNLOAD_DIR) || app.getPath('downloads')
    const path = join(dir, name)
    item.setSavePath(path)
    item.once('done', (_ev, state) => {
      if (state === 'completed') onDownload?.(path, name)
      else log.warn('[browser] download', state, name)
    })
  })
}

/* ——— 状态 ——— */

const tabUrl = (t: Tab): string => t.view.webContents.getURL()
const sensitive = (t: Tab): boolean => t.hasPassword || isSensitiveUrl(tabUrl(t), getSettings().browser?.aiBlockedSites ?? [])

function toTab(t: Tab): BrowserTab {
  const wc = t.view.webContents
  return {
    id: t.id,
    url: wc.getURL(),
    title: wc.getTitle() || wc.getURL(),
    favicon: t.favicon,
    loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
    incognito: t.incognito,
    sensitive: sensitive(t),
    sourceId: t.sourceId
  }
}

export function browserState(): BrowserState {
  return { tabs: order.map((id) => toTab(tabs.get(id)!)), activeId }
}

let emitTimer: NodeJS.Timeout | null = null
function changed(): void {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    emit('browser:state', browserState())
  }, 50)
}

/* ——— 视图 ——— */

function layout(): void {
  for (const t of tabs.values()) {
    const show = visible && !!bounds && t.id === activeId
    t.view.setVisible(show)
    if (show && bounds) t.view.setBounds(bounds)
  }
}

export function attach(win: BrowserWindow): void {
  if (host === win) return
  host = win
  win.on('closed', () => {
    for (const id of [...tabs.keys()]) closeTab(id)
    host = null
  })
}

function createTab(url: string, opts: { incognito?: boolean; activate?: boolean } = {}): Tab {
  if (!host) throw new Error('浏览器尚未就绪')
  const incognito = !!opts.incognito
  const partition = incognito ? `jiwei-incognito-${++incognitoSeq}` : PARTITION
  const ses = session.fromPartition(partition)
  setupSession(ses)
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: join(__dirname, '../preload/browser.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // 不需要的能力一律关闭
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false
    }
  })
  const t: Tab = { id: newId(), view, incognito, hasPassword: false, sourceId: null, openedAt: Date.now(), interactions: 0, favicon: null }
  tabs.set(t.id, t)
  order.push(t.id)
  host.contentView.addChildView(view)
  view.setVisible(false)
  const wc = view.webContents
  // 新窗口：在新标签页打开
  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) openTab(u, { incognito })
    else if (/^mailto:/i.test(u)) void shell.openExternal(u)
    return { action: 'deny' }
  })
  // 只允许 http(s) 与 about:blank
  wc.on('will-navigate', (e, u) => {
    if (!/^(https?:|about:blank)/i.test(u)) e.preventDefault()
  })
  wc.on('did-start-navigation', (_e, _u, inPlace, isMain) => {
    if (isMain && !inPlace) {
      t.hasPassword = false
      // 换了网址：不再对应之前存的资料
      t.sourceId = null
    }
  })
  for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const)
    wc.on(ev as 'did-start-loading', changed)
  wc.on('page-favicon-updated', (_e, icons) => {
    t.favicon = icons[0] ?? null
    changed()
  })
  wc.on('did-finish-load', () => onLoaded?.(t.id))
  // 焦点在网页中时，积微的快捷键也要生效：浏览器自身的在这里处理，其余转发给界面
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return
    const k = input.key.toLowerCase()
    if (k === 'r' && !input.shift) wc.reload()
    else if (k === '[') command(t.id, 'back')
    else if (k === ']') command(t.id, 'forward')
    else if (k === 't') openTab('', { incognito: input.shift })
    else if (['l', 'w', 'k', 'n', 'j', ',', '\\', '1', '2', '3', '4', '5', '6'].includes(k)) emit('browser:shortcut', { key: k, shift: input.shift })
    else return
    e.preventDefault()
  })
  wc.on('render-process-gone', (_e, d) => log.warn('[browser] render process gone', d.reason))
  void wc.loadURL(url || HOME).catch((e: Error) => log.warn('[browser] load failed', url, e.message))
  if (opts.activate !== false) activeId = t.id
  layout()
  changed()
  return t
}

let onLoaded: ((tabId: string) => void) | null = null
export function setLoadedHandler(fn: (tabId: string) => void): void {
  onLoaded = fn
}

/** 地址栏输入：网址直接打开，其余用搜索引擎 */
export function normalizeInput(input: string): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(s) && !/\s/.test(s)) return `https://${s}`
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(s)) return `http://${s}`
  const engine = getSettings().browser?.searchEngine ?? 'https://cn.bing.com/search?q='
  return engine + encodeURIComponent(s)
}

export function openTab(input: string, opts: { incognito?: boolean; activate?: boolean } = {}): string {
  return createTab(input ? normalizeInput(input) : HOME, opts).id
}

export function closeTab(id: string): void {
  const t = tabs.get(id)
  if (!t) return
  tabs.delete(id)
  const i = order.indexOf(id)
  order = order.filter((x) => x !== id)
  if (host && !host.isDestroyed()) host.contentView.removeChildView(t.view)
  if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
  if (activeId === id) activeId = order[Math.min(i, order.length - 1)] ?? null
  layout()
  changed()
}

export function activateTab(id: string): void {
  if (!tabs.has(id)) return
  activeId = id
  layout()
  changed()
}

export const getTab = (id?: string | null): Tab | null => tabs.get(id ?? activeId ?? '') ?? null

export function navigate(id: string, input: string): void {
  const t = getTab(id)
  if (t) void t.view.webContents.loadURL(normalizeInput(input)).catch(() => {})
}

export function command(id: string, cmd: 'back' | 'forward' | 'reload' | 'stop'): void {
  const wc = getTab(id)?.view.webContents
  if (!wc) return
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  else if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  else if (cmd === 'reload') wc.reload()
  else if (cmd === 'stop') wc.stop()
}

/** 渲染进程报告占位区域（窗口坐标）；null 表示浏览器不在屏幕上 */
export function setBounds(win: BrowserWindow | null, rect: { x: number; y: number; width: number; height: number } | null): void {
  if (win) attach(win)
  bounds = rect && rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null
  visible = !!bounds
  layout()
}

/** 弹出层（对话框、卡片）盖住浏览器时：暂停显示网页，返回当前画面截图 */
export async function freeze(on: boolean): Promise<string | null> {
  const t = getTab()
  if (!on) {
    visible = !!bounds
    layout()
    return null
  }
  const img = t && !t.view.webContents.isDestroyed() ? await t.view.webContents.capturePage().catch(() => null) : null
  visible = false
  layout()
  return img && !img.isEmpty() ? img.toDataURL() : null
}

export function markInteraction(id: string, sourceId?: string): void {
  const t = getTab(id)
  if (!t) return
  t.interactions++
  if (sourceId) t.sourceId = sourceId
  changed()
}

/** 关闭前的回顾条件：停留超过 5 分钟且有过提问或批注 */
export function recapInfo(id: string): { minutes: number; interactions: number; sourceId: string | null } | null {
  const t = getTab(id)
  return t ? { minutes: (Date.now() - t.openedAt) / 60000, interactions: t.interactions, sourceId: t.sourceId } : null
}

export function isSensitive(id?: string | null): boolean {
  const t = getTab(id)
  return !t || sensitive(t)
}

/** 网页视图的 WebContents → 标签页（内容脚本的消息只接受来自本浏览器的标签页） */
export function tabOf(wc: WebContents): Tab | null {
  for (const t of tabs.values()) if (t.view.webContents === wc) return t
  return null
}

export const isBrowserContents = (wc: WebContents): boolean => tabOf(wc) !== null

/** 在网页的隔离环境中执行只读脚本（读取正文、链接等） */
export async function inPage<T>(id: string | null | undefined, code: string): Promise<T> {
  const t = getTab(id)
  if (!t) throw new Error('没有打开的网页')
  return (await t.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }])) as T
}

/** 向内容脚本发送消息（如：更新高亮） */
export function toPage(id: string, channel: string, payload: unknown): void {
  const t = getTab(id)
  if (t && !t.view.webContents.isDestroyed()) t.view.webContents.send(channel, payload)
}

/* ——— 内容脚本消息 ——— */

export function registerContentIpc(handlers: {
  action: (tabId: string, msg: unknown) => void
  ready: (tabId: string) => void
}): void {
  ipcMain.on('jw-page:password', (e) => {
    const t = tabOf(e.sender)
    if (t && !t.hasPassword) {
      t.hasPassword = true
      changed()
    }
  })
  ipcMain.on('jw-page:action', (e, msg) => {
    const t = tabOf(e.sender)
    if (t && !t.incognito && !sensitive(t)) handlers.action(t.id, msg)
  })
  ipcMain.on('jw-page:ready', (e) => {
    const t = tabOf(e.sender)
    if (t) handlers.ready(t.id)
  })
  // 内容脚本的配置：本页是否允许 AI（敏感页面、无痕标签不显示浮条）与浮条文字
  ipcMain.handle('jw-page:config', (e) => {
    const t = tabOf(e.sender)
    const zh = getSettings().language.startsWith('zh')
    return {
      allowed: !!t && !t.incognito && !sensitive(t),
      labels: zh
        ? { explain: '解释', clarify: '讲明白', translate: '翻译', ask: '问 AI', highlighting: '高亮', commenting: '批注', questioning: '存疑' }
        : { explain: 'Explain', clarify: 'Clarify', translate: 'Translate', ask: 'Ask AI', highlighting: 'Highlight', commenting: 'Comment', questioning: 'Question' }
    }
  })
}
