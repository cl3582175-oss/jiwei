import { app, Menu, nativeImage, Tray, powerMonitor, type BrowserWindow } from 'electron'
import { getMainWindow } from '../../mainWindow'
import { getSettings } from '../settings'
import { listTasks, pauseAll } from './service'
import { catchUpTasks, initializeTaskScheduler } from './scheduler'
import { getDb } from '../../db'
import { aiTaskRuns } from '../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { onMainEvent } from '../../events'

let tray: Tray | null = null,
  quit = false,
  showWindow: () => void = () => {},
  timer: NodeJS.Timeout | null = null
// 本地生成 16×16 位图，不依赖打包时的工作目录或远程资源。
function trayImage() {
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let y = 2; y < 14; y++)
    for (let x = 3; x < 13; x++)
      if ((x >= 7 && x <= 8 && y >= 5) || (x <= 7 && y >= 4 && y <= 7 && x >= y - 2) || (x >= 9 && y <= 5 && x <= 15 - y)) {
        const at = (y * 16 + x) * 4
        pixels[at + 1] = process.platform === 'darwin' ? 0 : 110
        pixels[at + 2] = process.platform === 'darwin' ? 0 : 65
        pixels[at + 3] = 255
      }
  return nativeImage.createFromBitmap(pixels, { width: 16, height: 16 })
}
let unsubscribe: (() => void)[] = []
function menu(): void {
  if (!tray) return
  const zh = getSettings().language.startsWith('zh'),
    paused = getSettings().tasks.paused,
    running =
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(aiTaskRuns)
        .where(eq(aiTaskRuns.status, 'running'))
        .get()?.n ?? 0
  tray.setToolTip(zh ? '积微' : 'Jiwei')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: zh ? '打开积微' : 'Open Jiwei', click: () => showWindow() },
      { label: zh ? `正在运行的任务 ${running} 个` : `${running} running tasks`, enabled: false },
      {
        label: paused ? (zh ? '恢复全部任务' : 'Resume all tasks') : zh ? '暂停全部任务' : 'Pause all tasks',
        click: () => {
          pauseAll(!paused)
          menu()
        }
      },
      { type: 'separator' },
      { label: zh ? '退出' : 'Quit', click: () => app.quit() }
    ])
  )
}
export function applyResidency(): void {
  const settings = getSettings().tasks
  // 开发测试不修改系统登录项，安装版才由用户开关控制系统设置。
  if (app.isPackaged && ['darwin', 'win32'].includes(process.platform)) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
  if (settings.keepRunning && !tray) {
    const image = trayImage()
    if (process.platform === 'darwin') image.setTemplateImage(true)
    tray = new Tray(image)
    tray.on('click', () => showWindow())
    menu()
  }
  if (!settings.keepRunning && tray) {
    tray.destroy()
    tray = null
  }
  menu()
}
export function attachResidency(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (!quit && getSettings().tasks.keepRunning) {
      e.preventDefault()
      win.hide()
    }
  })
}
export function startResidency(open: () => void): void {
  quit = false
  showWindow = () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } else open()
  }
  applyResidency()
  void initializeTaskScheduler()
  timer = setTimeout(() => catchUpTasks(), 30000)
  powerMonitor.on('resume', resume)
  app.on('before-quit', () => {
    quit = true
  })
  unsubscribe = [onMainEvent('tasks:changed', menu), onMainEvent('tasks:run', menu)]
}
function resume(): void {
  catchUpTasks()
}
export function isResident(): boolean {
  return !!tray
}
export function stopResidency(): void {
  quit = true
  unsubscribe.forEach((off) => off())
  unsubscribe = []
  if (timer) clearTimeout(timer)
  timer = null
  powerMonitor.removeListener('resume', resume)
  tray?.destroy()
  tray = null
}
export function runningTaskCount(): number {
  return listTasks().filter((t) => t.lastResult?.status === 'running').length
}
