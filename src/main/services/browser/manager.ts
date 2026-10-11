import { tr } from '../../lib/messages'
import { captureText } from '../capture/messages'
import { join } from 'path'
import { app, BrowserWindow, WebContentsView, ipcMain, session, shell, type NativeImage, type Session, type WebContents } from 'electron'
import log from 'electron-log/main'
import { newId } from '../../lib/ids'
import { emit } from '../../events'
import type { BrowserState, BrowserTab, BrowserVideo, CourseState } from '@shared/types'
import { canonicalUrl, isSensitiveUrl } from '../../lib/browserPolicy'
import { getSettings, setSettings } from '../settings'
import { loginBlocked, domainMatches } from '@shared/browserSafety'
import { clearConcepts } from './concepts'
import type { ReadingState } from '@shared/reading'

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
  navigating: boolean
  committedUrl: string
  navigationUrl: string
  /** 已存为资料（同一网址复用） */
  sourceId: string | null
  /** 打开时间与互动次数（离开时的回顾） */
  openedAt: number
  interactions: number
  favicon: string | null
  video: BrowserVideo | null
  media: string | null
  scope: string
  /** 框选身份每次主框架导航都失效，不干扰课程的媒体会话。 */
  captureScope: string
  course: CourseState
  pendingSeek: { t: number; play: boolean; url: string } | null
  reading: ReadingState | null
  loginBlocked: BrowserTab['loginBlocked']
  externalNotice: BrowserTab['externalNotice']
  previousPage: string | null
  dismissedLogin: string | null
}

const initialCourse = (): CourseState => ({
  mode: 'auto',
  transcript: 'waiting',
  slides: getSettings().browser?.course?.autoSlides ?? true,
  quiz: getSettings().browser?.course?.quiz ?? false,
  recordingComplete: false,
  error: null
})

const tabs = new Map<string, Tab>()
let order: string[] = []
let activeId: string | null = null
let host: BrowserWindow | null = null
let bounds: { x: number; y: number; width: number; height: number } | null = null
let visible = false
let frozen = false
let freezeRevision = 0
let captureLease: string | null = null
let frozenImage: NativeImage | null = null
let incognitoSeq = 0

/* ——— 会话：浏览器式 UA、权限、下载 ——— */

const configured = new WeakSet<Session>()
type DownloadHandler = (path: string, name: string) => void
let onDownload: DownloadHandler | null = null
export function setDownloadHandler(fn: DownloadHandler): void {
  onDownload = fn
}

/** 去掉 UA 中的 Electron 与应用名（部分网站据此拒绝访问） */
const escapeHtml = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function failPage(code: number, desc: string, url: string): string {
  const offline = [-106, -105, -21].includes(code)
  const proxy = [-130, -111, -100, -101, -102, -118, -7].includes(code)
  const hint = offline
    ? '网络似乎已断开。'
    : proxy
      ? '连接被中断或超时。如果开了代理，请检查代理规则是否放行了这个网站。'
      : '这个网页暂时打不开。'
  return `<!doctype html><meta charset="utf-8"><title>无法打开网页</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;font:14px/1.7 -apple-system,'PingFang SC',sans-serif;color:#3b4442;background:#f6f7f5">
<div style="max-width:420px;padding:24px;text-align:center"><div style="font-size:36px">🌐</div>
<h1 style="font-size:17px;margin:8px 0">无法打开这个网页</h1><p style="margin:0 0 6px">${hint}</p>
<p style="margin:0 0 16px;color:#8a938f;font-size:12px;word-break:break-all">${escapeHtml(url)}<br>${escapeHtml(desc)}（${code}）</p>
<button onclick="location.reload()" style="font:inherit;padding:6px 16px;border-radius:8px;border:0;background:#2f6f6b;color:#fff;cursor:pointer">重新加载</button></div></body>`
}

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
const sensitive = (t: Tab): boolean =>
  t.navigating || t.hasPassword || isSensitiveUrl(tabUrl(t), getSettings().browser?.aiBlockedSites ?? [])

function toTab(t: Tab): BrowserTab {
  const wc = t.view.webContents
  return {
    id: t.id,
    scope: t.captureScope,
    url: wc.getURL(),
    title: wc.getTitle() || wc.getURL(),
    favicon: t.favicon,
    loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
    incognito: t.incognito,
    sensitive: sensitive(t),
    sourceId: t.sourceId,
    video: !t.incognito && !sensitive(t) ? t.video : null,
    course: t.course,
    reading: !t.incognito && !sensitive(t) ? t.reading : null,
    loginBlocked: t.loginBlocked,
    externalNotice: t.externalNotice
  }
}

export function browserState(): BrowserState {
  return { tabs: order.map((id) => toTab(tabs.get(id)!)), activeId }
}

let emitTimer: NodeJS.Timeout | null = null
export function changed(): void {
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
    if (show && bounds) {
      t.view.setBounds(bounds)
      if (fittedWidth.get(t.id) !== bounds.width) scheduleFit(t.id)
    }
  }
}

/**
 * 适应栏宽：很多网站规定了最小宽度（如 1100px 以上），比笔记旁的浏览器栏还宽，
 * 右侧内容会被栏位截掉。此时按比例缩小显示（不低于 67%），让整页放进栏里；栏变宽时恢复。
 */
const fittedWidth = new Map<string, number>()
const fitTimers = new Map<string, NodeJS.Timeout>()
function scheduleFit(id: string): void {
  clearTimeout(fitTimers.get(id))
  fitTimers.set(
    id,
    setTimeout(() => {
      fitTimers.delete(id)
      void fitWidth(id)
    }, 250)
  )
}
// 每个标签页当前网页的最小宽度（CSS 像素）；记下后按栏宽直接换算，不必先复位到 100% 再量（避免闪烁）
const pageMinWidth = new Map<string, number>()
async function fitWidth(id: string): Promise<void> {
  const t = tabs.get(id),
    width = bounds?.width
  // 框选识别进行中（冻结画面、识别卡片改变栏宽）不调整缩放，避免截图与网页排版不一致
  if (!t || !width || frozen || captureLease || t.view.webContents.isDestroyed()) return
  const wc = t.view.webContents
  try {
    const zoom = wc.getZoomFactor()
    const [scrollWidth, innerWidth] = (await wc.executeJavaScript(
      '[Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0),innerWidth]'
    )) as [number, number]
    if (wc.isDestroyed()) return
    // 页面溢出时，此刻的滚动宽度就是网页的最小宽度
    if (scrollWidth > innerWidth + 2) pageMinWidth.set(id, scrollWidth)
    const min = pageMinWidth.get(id)
    const target = min ? Math.min(1, Math.max(0.67, Math.floor((width / min) * 100) / 100)) : 1
    if (Math.abs(target - zoom) > 0.01) wc.setZoomFactor(target)
    // 沿用了上一页的缩小比例、又不知道这一页的最小宽度：恢复 100% 后再量一次
    if (!min && zoom < 1) {
      fittedWidth.delete(id)
      scheduleFit(id)
      return
    }
    fittedWidth.set(id, width)
  } catch {
    /* 页面正在跳转：下一次加载完成会重新适应 */
  }
}
/** 网页上报的坐标是 CSS 像素，缩放后需乘以缩放比例才是栏内像素 */
export const tabZoom = (id: string): number => {
  const wc = tabs.get(id)?.view.webContents
  return wc && !wc.isDestroyed() ? wc.getZoomFactor() : 1
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
  const t: Tab = {
    id: newId(),
    view,
    incognito,
    hasPassword: false,
    navigating: true,
    committedUrl: '',
    navigationUrl: url || HOME,
    sourceId: null,
    openedAt: Date.now(),
    interactions: 0,
    favicon: null,
    video: null,
    media: null,
    scope: newId(),
    captureScope: newId(),
    course: initialCourse(),
    pendingSeek: null,
    reading: null,
    loginBlocked: null,
    externalNotice: null,
    previousPage: null,
    dismissedLogin: null
  }
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
    else if (redirectExternal(t, u)) e.preventDefault()
  })
  wc.on('will-redirect', (e, u, _inPlace, isMain) => {
    if (isMain && redirectExternal(t, u)) e.preventDefault()
  })
  wc.on('did-start-navigation', (_e, targetUrl, inPlace, isMain) => {
    if (isMain) {
      t.captureScope = newId()
      changed()
      if (t.pendingSeek && canonicalUrl(t.pendingSeek.url) !== canonicalUrl(targetUrl)) t.pendingSeek = null
      t.navigationUrl = targetUrl
      t.dismissedLogin = null
      if (t.committedUrl && /^https?:/.test(t.committedUrl) && !loginBlocked(t.committedUrl, '', '', testLoginHosts()))
        t.previousPage = t.committedUrl
      const reason = loginBlocked(targetUrl, '', '', testLoginHosts())
      t.loginBlocked = reason ? { reason, url: t.previousPage ?? targetUrl } : null
      if (inPlace && canonicalUrl(t.committedUrl) === canonicalUrl(targetUrl)) return
      readingReset?.(t.id)
      if (!inPlace) t.navigating = true
      // 换了网址：不再对应之前存的资料
      t.sourceId = null
      invalidateCourse(t)
    }
  })
  wc.on('did-navigate', (_e, url) => {
    t.navigating = false
    t.hasPassword = false
    t.committedUrl = url
    changed()
  })
  wc.on('did-navigate-in-page', (_e, _url, isMain) => {
    if (isMain) {
      t.committedUrl = _url
      pushConfig(t.id)
      onLoaded?.(t.id)
    }
  })
  for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const)
    wc.on(ev as 'did-start-loading', changed)
  wc.on('page-favicon-updated', (_e, icons) => {
    t.favicon = icons[0] ?? null
    changed()
  })
  // 学习活动记录（v0.6.7）：网页是原生视图，渲染进程看不到其中的操作与播放，由这里节流后通知。
  // 只发“有操作 / 在播放”的信号，不发网址和内容；无痕标签不计。
  let lastPulse = 0
  wc.on('input-event', () => {
    if (t.incognito || Date.now() - lastPulse < 5000) return
    lastPulse = Date.now()
    emit('activity:pulse', { source: 'browser', playing: null })
  })
  wc.on('media-started-playing', () => {
    if (!t.incognito) emit('activity:pulse', { source: 'browser', playing: true })
  })
  wc.on('media-paused', () => {
    if (!t.incognito) emit('activity:pulse', { source: 'browser', playing: false })
  })
  wc.on('did-finish-load', () => {
    void checkLogin(t)
    onLoaded?.(t.id)
    fittedWidth.delete(t.id)
    pageMinWidth.delete(t.id)
    if (t.id === activeId) scheduleFit(t.id)
  })
  // Electron 没有内置的错误页：主框架加载失败时写入一个简短说明与“重新加载”，否则只剩一片空白
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return // -3：用户或页面自己中止
    const html = failPage(code, desc, url)
    void wc.executeJavaScript(`document.open();document.write(${JSON.stringify(html)});document.close();`).catch(() => undefined)
  })
  // 焦点在网页中时，积微的快捷键也要生效：浏览器自身的在这里处理，其余转发给界面
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return
    const k = input.key.toLowerCase()
    if (k === 'r' && !input.shift) wc.reload()
    else if (k === '[') command(t.id, 'back')
    else if (k === ']') command(t.id, 'forward')
    else if (k === 't' && !input.shift) openTab('')
    else if (k === 'n' && input.shift) openTab('', { incognito: true })
    else if (k === 't' && input.shift) emit('browser:shortcut', { key: k, shift: true })
    else if (['l', 'w', 'k', 'n', 'j', ',', '\\', '1', '2', '3', '4', '5', '6'].includes(k))
      emit('browser:shortcut', { key: k, shift: input.shift })
    else return
    e.preventDefault()
  })
  wc.on('render-process-gone', (_e, d) => log.warn('[browser] render process gone', d.reason))
  void wc.loadURL(redirectExternal(t, url) ? HOME : url || HOME).catch((e: Error) => log.warn('[browser] load failed', url, e.message))
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
  readingReset?.(t.id)
  invalidateCourse(t)
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
  if (t) {
    t.pendingSeek = null
    const url = normalizeInput(input)
    if (!redirectExternal(t, url)) void t.view.webContents.loadURL(url).catch(() => {})
  }
}

const testLoginHosts = (): string[] => (!app.isPackaged ? (process.env.JIWEI_TEST_LOGIN_BLOCK_HOSTS ?? '').split(',').filter(Boolean) : [])
async function checkLogin(t: Tab): Promise<void> {
  const wc = t.view.webContents
  if (wc.isDestroyed() || !/^https?:/.test(wc.getURL()) || t.dismissedLogin === wc.getURL()) return
  const url = wc.getURL()
  const host = new URL(url).hostname
  if (!domainMatches(host, 'youtube.com') && host !== 'accounts.google.com' && !testLoginHosts().includes(host)) return
  try {
    const body = (await wc.executeJavaScript('(document.body?.innerText ?? "").slice(0, 100000)')) as string
    if (wc.isDestroyed() || wc.getURL() !== url) return
    const reason = loginBlocked(url, wc.getTitle(), body, testLoginHosts())
    if (reason) {
      t.loginBlocked = { reason, url: reason === 'google' ? (t.previousPage ?? url) : url }
      changed()
    }
  } catch {
    /* 导航中由下一次 ready 消息继续。 */
  }
}
function redirectExternal(t: Tab, url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  const site = (getSettings().browser?.externalSites ?? []).find((s) => domainMatches(new URL(url).hostname, s))
  if (!site) return false
  t.externalNotice = { site, url }
  changed()
  void shell.openExternal(url).catch(() => {})
  return true
}
export async function openExternalTab(id: string): Promise<void> {
  const t = getTab(id),
    url = t?.loginBlocked?.url ?? t?.externalNotice?.url ?? (t ? tabUrl(t) : '')
  if (!/^https?:\/\//i.test(url)) throw new Error(tr('只能在系统浏览器中打开网页网址', 'Only web addresses can be opened in the system browser'))
  await shell.openExternal(url)
}
export function dismissLogin(id: string): void {
  const t = getTab(id)
  if (t) {
    t.dismissedLogin = tabUrl(t)
    t.loginBlocked = null
    changed()
  }
}
export function setExternalSite(site: string, enabled: boolean): void {
  const s = getSettings().browser ?? {},
    sites = new Set(s.externalSites ?? [])
  if (enabled) sites.add(site)
  else sites.delete(site)
  setSettings({ browser: { ...s, externalSites: [...sites] } })
  for (const t of tabs.values()) if (t.externalNotice?.site === site && !enabled) t.externalNotice = null
  changed()
}

ipcMain.on('jw-page:login-safety', (event) => {
  const t = [...tabs.values()].find((t) => t.view.webContents === event.sender)
  if (t && event.senderFrame === event.sender.mainFrame) void checkLogin(t)
})

let courseReset: ((id: string) => void) | null = null
export function onCourseReset(fn: (id: string) => void): void {
  courseReset = fn
}

function invalidateCourse(t: Tab): void {
  clearConcepts(t.id)
  courseReset?.(t.id)
  t.video = null
  t.media = null
  t.scope = newId()
  t.course = initialCourse()
  changed()
}

export function clearVideo(id: string): void {
  const t = getTab(id)
  if (!t) return
  courseReset?.(id)
  t.video = null
  t.media = null
  t.course = initialCourse()
  changed()
}

export function setVideo(id: string, media: string, video: Omit<BrowserVideo, 'mediaId'>): void {
  const t = getTab(id)
  if (!t || t.incognito || sensitive(t)) return
  const replaced = !!t.media && t.media !== media
  if (replaced) {
    courseReset?.(id)
    t.sourceId = null
    t.course = initialCourse()
  }
  t.media = media
  t.video = { ...video, mediaId: media }
  if (replaced) pushConfig(id)
  if (t.pendingSeek) {
    const pending = t.pendingSeek
    t.pendingSeek = null
    if (canonicalUrl(pending.url) === canonicalUrl(tabUrl(t))) seek(id, pending.t, pending.play)
  }
  changed()
}

export function seek(id: string, at: number, play = false): void {
  const t = getTab(id)
  if (!t || t.incognito || (sensitive(t) && !t.navigating)) throw new Error('Video unavailable')
  if (!t.video) {
    t.pendingSeek = { t: at, play, url: t.navigationUrl || tabUrl(t) }
    return
  }
  toPage(id, 'jw-page:seek', { t: Math.min(at, t.video.duration), play })
}

export function playback(id: string, play: boolean): void {
  const t = getTab(id)
  if (!t || !t.video || t.incognito || sensitive(t)) return
  toPage(id, play ? 'jw-page:play' : 'jw-page:pause', {})
}

export function pageConfig(id: string): {
  allowed: boolean
  scope: string
  course: CourseState
  language: string
  labels: Record<string, string>
} {
  const t = getTab(id)
  const zh = getSettings().language.startsWith('zh')
  return {
    allowed: !!t && !t.incognito && !sensitive(t),
    scope: t?.scope ?? '',
    language: getSettings().language,
    course: t?.course ?? initialCourse(),
    labels: zh
      ? {
          explain: '解释',
          clarify: '讲明白',
          translate: '翻译',
          grammar: '讲语法',
          ask: '问 AI',
          highlighting: '高亮',
          commenting: '批注',
          questioning: '存疑'
        }
      : {
          explain: 'Explain',
          clarify: 'Clarify',
          translate: 'Translate',
          grammar: 'Grammar',
          ask: 'Ask AI',
          highlighting: 'Highlight',
          commenting: 'Comment',
          questioning: 'Question'
        }
  }
}

export function pushConfig(id: string): void {
  toPage(id, 'jw-page:config-update', pageConfig(id))
}

/** 设置与密码变化即时撤销采集，不能等下一次页面加载。 */
export function refreshPrivacy(): void {
  for (const t of tabs.values()) {
    if (t.incognito || sensitive(t)) {
      invalidateCourse(t)
      readingReset?.(t.id)
    }
    pushConfig(t.id)
  }
  changed()
}

/** 设置是所有打开课程的默认偏好；仅改动用户在设置中明确切换的选项。 */
export function refreshCourseSettings(patch: { autoSlides?: boolean; quiz?: boolean }): void {
  for (const t of tabs.values()) {
    if (patch.autoSlides !== undefined) t.course.slides = patch.autoSlides
    if (patch.quiz !== undefined) t.course.quiz = patch.quiz
    pushConfig(t.id)
  }
  changed()
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
  bounds =
    rect && rect.width > 0 && rect.height > 0
      ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      : null
  visible = !!bounds && !frozen
  layout()
}

/** 弹出层（对话框、卡片）盖住浏览器时：暂停显示网页，返回当前画面截图 */
export async function freeze(on: boolean): Promise<string | null> {
  // 显式框选独占冻结帧，普通弹层不能替换或解除它。
  if (captureLease) return frozenImage?.toDataURL() ?? null
  const t = getTab()
  const revision = ++freezeRevision
  frozen = on
  if (!on) {
    frozenImage = null
    visible = !!bounds
    layout()
    return null
  }
  const scope = t?.captureScope
  const img =
    t && !t.incognito && !sensitive(t) && !t.view.webContents.isDestroyed()
      ? await t.view.webContents.capturePage().catch(() => null)
      : null
  if (revision !== freezeRevision) return null
  visible = false
  layout()
  frozenImage = t && getTab()?.id === t.id && t.captureScope === scope && !sensitive(t) && img && !img.isEmpty() ? img : null
  return frozenImage?.toDataURL() ?? null
}

/** 保存完整原始帧，裁剪与占位图来自同一次 capturePage，动画不会导致错帧。 */
export async function beginCaptureFreeze(id: string): Promise<NativeImage> {
  await endCaptureFreeze()
  // 界面上的提示气泡、菜单盖住网页时也会请求冻结；两次请求交错会让这一次作废，重试几次
  let result: string | null = null
  // 刚打开或刚调整布局时网页视图可能还没就位（截图为空），稍等再试
  for (let attempt = 0; attempt < 4 && !(result && frozenImage); attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 150 * attempt))
    result = await freeze(true)
  }
  if (!result || !frozenImage) {
    await freeze(false)
    throw new Error(captureText('pageChanged'))
  }
  captureLease = id
  return frozenImage
}
export async function endCaptureFreeze(id?: string): Promise<void> {
  if (id && captureLease !== id) return
  captureLease = null
  await freeze(false)
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

export function registerContentIpc(handlers: { action: (tabId: string, msg: unknown) => void; ready: (tabId: string) => void }): void {
  ipcMain.on('jw-page:password', (e) => {
    const t = tabOf(e.sender)
    if (t && e.senderFrame === e.sender.mainFrame && !t.hasPassword) {
      t.hasPassword = true
      readingReset?.(t.id)
      t.pendingSeek = null
      invalidateCourse(t)
      pushConfig(t.id)
      changed()
    }
  })
  ipcMain.on('jw-page:action', (e, msg) => {
    const t = tabOf(e.sender)
    if (t && e.senderFrame === e.sender.mainFrame && !t.incognito && !sensitive(t)) handlers.action(t.id, msg)
  })
  ipcMain.on('jw-page:ready', (e) => {
    const t = tabOf(e.sender)
    if (t && e.senderFrame === e.sender.mainFrame) handlers.ready(t.id)
  })
  // 内容脚本的配置：本页是否允许 AI（敏感页面、无痕标签不显示浮条）与浮条文字
  ipcMain.handle('jw-page:config', (e) => {
    const t = tabOf(e.sender)
    return pageConfig(e.senderFrame === e.sender.mainFrame ? (t?.id ?? '') : '')
  })
}

let readingReset: ((tabId: string) => void) | null = null
export function onReadingReset(handler: (tabId: string) => void): void {
  readingReset = handler
}
