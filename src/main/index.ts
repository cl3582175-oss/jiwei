import { getMainWindow, setMainWindow } from './mainWindow'
import { initializePlugins } from './services/plugins/install'
import { initializeMarkets } from './services/plugins/markets'
import { registerCapture, stopCapture } from './services/capture'
import { registerImporterJobs } from './services/importer/run'
import { registerImportCueJob } from './services/importer/cues'
import { shutdown as stopPhoneUpload } from './services/phoneUpload'
import { registerInboxJobs } from './services/inbox'
import { registerMistakeJobs } from './services/mistakes'
import { registerMistakeEntryGuards } from './services/mistakeEntries'
import { app, BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import { openDatabase, closeDatabase } from './db'
import { closeProfileDb } from './db/profile'
import { registerIpc } from './ipc'
import { purgeExpired } from './services/trash'
import { applyNativeTheme, getSettings } from './services/settings'
import { registerProtocol, registerSchemePrivileges, collectGarbage } from './services/assets'
import { autoBackup } from './services/backup'
import { flushAll, pruneRevisions, rebuildNoteImageReferences } from './services/docs'
import { requestRendererFlush } from './lifecycle'
import { ensureIdentity } from './services/device'
import { registerJobKinds, resegmentEmptyPdfs } from './services/jobKinds'
import { registerRecognizeJob, visionModel } from './services/recognize'
import { registerBrowser } from './services/browser'
import { registerAsrJob } from './services/asr'
import { registerMossJob, stopMoss } from './services/moss'
import { registerRecording } from './services/recording'
import { registerLensJobs } from './services/lenses'
import { registerDigestJob } from './services/digest'
import { stopVoiceprint } from './services/voiceprint'
import { pruneJobs, setOffPeakPolicy, startJobs, stopJobs } from './services/jobs'
import { hasOffPeak } from './services/agent/pricing'
import { startRateUpdates } from './services/agent/rates'
import { isDeepSeekPeak } from '@shared/ai'
import { nextOffPeak } from '@shared/inbox'
import { reconcilePeopleReferences } from './services/people'
import { emit } from './events'
import { registerIndexJob, requestIndex } from './services/ai/indexer'
import { refreshStatus, shutdown as shutdownEmbedding } from './services/ai/embedding'
import { stopAll as stopChats } from './services/ai/chat'
import { startServe, stopServe } from './services/mcp/serve'
import { closeAllMcp } from './services/mcp/client'
import { stopCallbackServer } from './services/mcp/oauth'
import { denyAll } from './services/agent/approval'
import { pruneAudit } from './services/agent/audit'
import { startMemoryLearning, stopMemoryLearning } from './services/memoryLearn'
import { syncAllCards } from './services/review'
import { startReminders, stopReminders } from './services/reminders'
import { registerTaskJob } from './services/tasks/runner'
import { registerFeedJob } from './services/discover/feeds'
import { registerDailyJob } from './services/discover/daily'
import { registerPodcastJob } from './services/discover/podcast'
import { recoverTaskRuns } from './services/tasks/service'
import { startResidency, stopResidency, attachResidency, isResident } from './services/tasks/residency'
import { importProvidersForTest } from './services/ai/providers'
import { initializeBackupSafety, backupOperation } from './services/fullBackup'
import { setMessageLanguage } from './lib/messages'
import { initializeRecordingFiles, resumeCryptoMigration, clearRecordingKeys, cryptoOperation } from './services/recordingFiles'
import { refreshBrowserNetwork } from './services/browser/network'
import { startUpdates, stopUpdates } from './services/updates'

const HOUR = 3_600_000
const DEEP_LINK = /^jiwei:\/\/(note|source)\/([0-9a-f-]{36})/i

// 深层链接：外部应用点击 jiwei://note/<id> 时打开对应笔记
let pendingLink: string | null = null
function handleDeepLink(url: string | undefined): void {
  const m = url ? DEEP_LINK.exec(url) : null
  if (!m) return
  const win = getMainWindow()
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
// 只记录不弹窗：退出过程中的偶发错误不能用对话框阻塞退出
log.errorHandler.startCatching({ showDialog: false })

// 真实服务商端到端测试：Playwright 默认注入 --use-mock-keychain，会导致无法解密用户保存的 API Key
if (!app.isPackaged && process.env.JIWEI_IMPORT_PROVIDERS_FROM) app.commandLine.removeSwitch('use-mock-keychain')
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
    // 层级 0（桌面）：macOS 毛玻璃、Windows 11 Mica 材质；Linux 使用不透明底色
    ...(isMac
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const, backgroundColor: '#00000000' }
      : process.platform === 'win32'
        ? { backgroundMaterial: 'mica' as const, backgroundColor: '#00000000' }
        : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1618' : '#e7ecea' }),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    ...(isMac ? {} : { titleBarOverlay: { color: '#00000000', symbolColor: '#888', height: 44 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // 内置 PDF 查看器（v0.2 改用 PDF.js 以支持页码定位与批注）
      plugins: true
    }
  })

  setMainWindow(win)
  attachResidency(win)
  win.on('closed', () => {
    void stopPhoneUpload()
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
  const win = getMainWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  handleDeepLink(argv.find((a) => a.startsWith('jiwei://')))
})

app.whenReady().then(async () => {
  setMessageLanguage(process.env.JIWEI_LANG || app.getLocale())
  electronApp.setAppUserModelId('io.github.cl3582175-oss.jiwei')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  await initializeBackupSafety()
  await openDatabase()
  ensureIdentity()
  await initializePlugins()
  await initializeMarkets()
  await initializeRecordingFiles()
  resumeCryptoMigration()
  await refreshBrowserNetwork()
  // 仅开发 / 测试：导入服务商配置（见 importProvidersForTest）
  if (!app.isPackaged && process.env.JIWEI_IMPORT_PROVIDERS_FROM) {
    log.info('[test] imported providers:', importProvidersForTest(process.env.JIWEI_IMPORT_PROVIDERS_FROM))
  }
  applyNativeTheme(getSettings())
  registerProtocol()
  registerIpc()
  registerJobKinds()
  registerTaskJob()
  registerFeedJob()
  registerDailyJob()
  registerPodcastJob()
  recoverTaskRuns()
  registerAsrJob()
  registerMossJob()
  registerRecording()
  registerLensJobs()
  registerRecognizeJob()
  registerDigestJob()
  registerImporterJobs()
  registerImportCueJob()
  // 低谷时段运行（v0.7.5）：开启后，可延后的后台任务在 DeepSeek 高峰期排到下一个低谷
  setOffPeakPolicy((at) => {
    const s = getSettings()
    if (!s.money.offPeakJobs || !isDeepSeekPeak(at)) return at
    const vm = visionModel()
    return hasOffPeak(s.ai.chat.providerId, s.ai.chat.model) || (vm && hasOffPeak(vm.providerId, vm.model)) ? nextOffPeak(at) : at
  })
  startRateUpdates()
  registerBrowser()
  registerIndexJob()
  registerInboxJobs()
  registerMistakeEntryGuards()
  registerMistakeJobs()
  reconcilePeopleReferences()
  startJobs()
  void rebuildNoteImageReferences().catch((e) => log.warn('[note images] backfill failed', e))
  startMemoryLearning()
  startReminders()
  // v0.7：让其他应用使用积微（MCP 服务，默认关闭）
  void startServe().catch((e) => log.warn('[mcp-serve] start failed', e))
  // 复习卡片：补齐已有笔记的线索（升级到 v0.4 后第一次启动）
  setTimeout(() => {
    try {
      syncAllCards()
    } catch (e) {
      log.warn('[review] sync failed', e)
    }
    try {
      const n = resegmentEmptyPdfs()
      if (n) log.info('[sources] re-parse PDFs without segments', n)
    } catch (e) {
      log.warn('[sources] re-parse failed', e)
    }
  }, 3000)
  // 向量模型已安装则补齐索引（例如上次退出时未完成的部分）
  void refreshStatus().then((s) => s.state === 'ready' && requestIndex())
  handleDeepLink(process.argv.find((a) => a.startsWith('jiwei://')))

  const maintenance = async (): Promise<void> => {
    try {
      await purgeExpired()
      pruneRevisions()
      pruneJobs()
      pruneAudit()
      await collectGarbage()
    } catch (e) {
      log.error('[maintenance] failed', e)
    }
  }
  void autoBackup().then(maintenance)
  setInterval(() => {
    void autoBackup()
    void maintenance()
  }, HOUR)

  await startUpdates()
  createWindow()
  startResidency(createWindow)
  registerCapture()
  app.on('activate', () => {
    if (!getMainWindow()) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isResident()) app.quit()
})

// 退出前：让界面推送未保存的编辑 → 完成派生 → 关闭数据库
let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  void requestRendererFlush()
    .catch(() => undefined)
    .finally(async () => {
      stopResidency()
      stopCapture()
      stopUpdates()
      await stopPhoneUpload()
      denyAll()
      stopChats()
      await Promise.all([stopServe(), closeAllMcp()]).catch(() => undefined)
      stopCallbackServer()
      stopMemoryLearning()
      stopReminders()
      shutdownEmbedding()
      stopJobs()
      stopMoss()
      stopVoiceprint()
      await Promise.all([backupOperation.stop(), cryptoOperation.stop()])
      flushAll()
      closeDatabase()
      closeProfileDb()
      clearRecordingKeys()
      app.quit()
    })
})
