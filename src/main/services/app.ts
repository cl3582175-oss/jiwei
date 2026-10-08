import { app, BrowserWindow, dialog, shell } from 'electron'
import { cp, readdir } from 'fs/promises'
import log from 'electron-log/main'
import { closeDatabase, dataDir } from '../db'
import { defaultDataDir, looksLikeCloudFolder, readBootConfig, writeBootConfig } from '../lib/config'
import { flushAll } from './docs'
import { requestRendererFlush } from '../lifecycle'
import type { AppInfo } from '@shared/types'

export function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    dataDir: dataDir(),
    dataDirIsDefault: dataDir() === defaultDataDir(),
    dataDirInCloud: looksLikeCloudFolder(dataDir()),
    platform: process.platform
  }
}

/**
 * 迁移数据目录：选择一个空文件夹 → 保存并关闭数据库 → 复制全部数据 → 记录新位置 → 重启。
 * 原目录保留不动，用户确认无误后可自行删除。
 */
export async function changeDataDir(win: BrowserWindow | null): Promise<boolean> {
  const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], buttonLabel: '选择' }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return false
  const target = res.filePaths[0]
  if (target === dataDir()) return false
  const entries = (await readdir(target)).filter((n) => !n.startsWith('.'))
  if (entries.length > 0) throw new Error('请选择一个空文件夹 / Please choose an empty folder')
  if (looksLikeCloudFolder(target)) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['仍然使用', '取消'],
      defaultId: 1,
      message: '这个文件夹似乎位于云同步盘中',
      detail: '云同步可能在写入过程中同步数据库文件，导致数据损坏。建议使用本地文件夹，并通过“备份”功能保护数据。'
    })
    if (response !== 0) return false
  }
  await requestRendererFlush()
  flushAll()
  const from = dataDir()
  closeDatabase()
  log.info('[app] copying data dir', from, '→', target)
  await cp(from, target, { recursive: true, errorOnExist: false })
  const cfg = readBootConfig()
  writeBootConfig({ ...cfg, dataDir: target, vaults: (cfg.vaults ?? []).map((v) => (v.path === from ? { ...v, path: target } : v)) })
  app.relaunch()
  app.exit(0)
  return true
}

export async function openDataDir(): Promise<void> {
  await shell.openPath(dataDir())
}
