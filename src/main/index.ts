import { app, BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import { openDatabase, closeDatabase } from './db'
import { registerIpc } from './ipc'
import { purgeExpired } from './services/trash'
import { applyNativeTheme, getSettings } from './services/settings'
import { registerProtocol, registerSchemePrivileges, collectGarbage } from './services/assets'
import { autoBackup } from './services/backup'
import { flushAll, pruneRevisions } from './services/docs'
import { requestRendererFlush } from './lifecycle'
import { ensureIdentity } from './services/device'
import { registerJobKinds } from './services/jobKinds'
import { pruneJobs, startJobs, stopJobs } from './services/jobs'
import { emit } from './events'

const HOUR = 3_600_000
const DEEP_LINK = /^jiwei:\/\/(note|source)\/([0-9a-f-]{36})/i

// 深层链接：外部应用点击 jiwei://note/<id> 时打开对应笔记
let pendingLink: string | null = null
function handleDeepLink(url: string | undefined): void {
  const m = url ? DEEP_LINK.exec(url) : null
  if (!m) return
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    pendingLink = url!
    return
  }
  if (win.isMinimized()) win.restore()
  win.focus()
  emit('nav:open', { type: m[1].toLowerCase() as 'note' | 'source', id: m[2] })
}
// 只有安装版才向系统注册 jiwei:// 协议（开发与测试运行不修改系统设置）
if (app.isPackaged) app.setAsDefaultProtocolClient('jiwei')
app.on('open-url', (e, url) => {
  e.preventDefault()
  handleDeepLink(url)
})

log.initialize()
log.errorHandler.startCatching()
registerSchemePrivileges()

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1440,
    height: 890, // 1440 / 1.618
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: '积微',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181a' : '#fbfaf7',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    ...(isMac ? {} : { titleBarOverlay: { color: '#00000000', symbolColor: '#888', height: 44 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => {
    if (pendingLink) setTimeout(() => handleDeepLink(pendingLink!), 500)
    pendingLink = null
  })

  // 外部链接一律交给系统浏览器；应用内不允许跳转到其他页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.on('render-process-gone', (_, details) => log.error('[renderer] gone', details))

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', (_, argv) => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  handleDeepLink(argv.find((a) => a.startsWith('jiwei://')))
})

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.github.cl3582175-oss.jiwei')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  await openDatabase()
  ensureIdentity()
  applyNativeTheme(getSettings())
  registerProtocol()
  registerIpc()
  registerJobKinds()
  startJobs()
  handleDeepLink(process.argv.find((a) => a.startsWith('jiwei://')))

  const maintenance = async (): Promise<void> => {
    try {
      await purgeExpired()
      pruneRevisions()
      pruneJobs()
      await collectGarbage()
    } catch (e) {
      log.error('[maintenance] failed', e)
    }
  }
  void autoBackup().then(maintenance)
  setInterval(() => void maintenance(), HOUR)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前：让界面推送未保存的编辑 → 完成派生 → 关闭数据库
let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  void requestRendererFlush()
    .catch(() => undefined)
    .finally(() => {
      stopJobs()
      flushAll()
      closeDatabase()
      app.quit()
    })
})
