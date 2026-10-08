import { app, BrowserWindow, dialog } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { basename, join } from 'path'
import log from 'electron-log/main'
import { dataDir } from '../db'
import { defaultDataDir, looksLikeCloudFolder, readBootConfig, writeBootConfig, type VaultEntry } from '../lib/config'
import { flushAll } from './docs'
import { closeDatabase } from '../db'
import { requestRendererFlush } from '../lifecycle'
import { newId } from '../lib/ids'
import { setVaultName, vaultName } from './device'
import type { Vault } from '@shared/types'

// 知识库 = 一个数据目录。可以创建、打开、切换多个知识库；共享时同步整个目录。

function entries(): VaultEntry[] {
  const cfg = readBootConfig()
  const list = cfg.vaults ?? []
  // 兼容旧配置：只有 dataDir 时视为唯一知识库
  const current = dataDir()
  if (!list.some((v) => v.path === current)) {
    list.unshift({ id: newId(), name: vaultName() ?? (current === defaultDataDir() ? '我的知识库' : basename(current)), path: current })
    writeBootConfig({ ...cfg, vaults: list, dataDir: current })
  }
  return list
}

export function listVaults(): Vault[] {
  const current = dataDir()
  return entries().map((v) => ({ ...v, active: v.path === current, ...(v.path === current && vaultName() ? { name: vaultName()! } : {}) }))
}

async function relaunchInto(path: string): Promise<void> {
  await requestRendererFlush()
  flushAll()
  closeDatabase()
  writeBootConfig({ ...readBootConfig(), dataDir: path })
  log.info('[vaults] switching to', path)
  app.relaunch()
  app.exit(0)
}

async function pickFolder(win: BrowserWindow | null, title: string): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = { title, properties: ['openDirectory', 'createDirectory'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return res.canceled ? null : (res.filePaths[0] ?? null)
}

async function confirmCloud(path: string): Promise<boolean> {
  if (!looksLikeCloudFolder(path)) return true
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['仍然使用', '取消'],
    defaultId: 1,
    message: '这个文件夹似乎位于云同步盘中',
    detail: '云同步可能在写入过程中同步数据库文件，导致数据损坏。建议使用本地文件夹。'
  })
  return response === 0
}

/** 在空文件夹中新建知识库并切换过去 */
export async function createVault(win: BrowserWindow | null, name: string): Promise<Vault | null> {
  const parent = await pickFolder(win, '选择新知识库的位置')
  if (!parent) return null
  const path = (await readdir(parent)).filter((n) => !n.startsWith('.')).length === 0 ? parent : join(parent, name)
  if (existsSync(path) && (await readdir(path)).filter((n) => !n.startsWith('.')).length > 0) throw new Error('目标文件夹不是空的')
  if (!(await confirmCloud(path))) return null
  await mkdir(path, { recursive: true })
  const entry = { id: newId(), name, path }
  const cfg = readBootConfig()
  writeBootConfig({ ...cfg, vaults: [...entries(), entry] })
  await relaunchInto(path)
  return { ...entry, active: true }
}

/** 打开一个已有的知识库文件夹（含 jiwei.db） */
export async function openVault(win: BrowserWindow | null): Promise<Vault | null> {
  const path = await pickFolder(win, '选择知识库文件夹')
  if (!path) return null
  if (!existsSync(join(path, 'jiwei.db'))) throw new Error('这个文件夹里没有积微知识库（jiwei.db）')
  if (!(await confirmCloud(path))) return null
  const list = entries()
  let entry = list.find((v) => v.path === path)
  if (!entry) {
    entry = { id: newId(), name: basename(path), path }
    writeBootConfig({ ...readBootConfig(), vaults: [...list, entry] })
  }
  await relaunchInto(path)
  return { ...entry, active: true }
}

export async function switchVault(id: string): Promise<void> {
  const v = entries().find((x) => x.id === id)
  if (!v) throw new Error('Vault not found')
  if (v.path === dataDir()) return
  if (!existsSync(v.path)) throw new Error(`找不到知识库文件夹：${v.path}`)
  await relaunchInto(v.path)
}

export function renameVault(id: string, name: string): void {
  const cfg = readBootConfig()
  const list = entries().map((v) => (v.id === id ? { ...v, name } : v))
  writeBootConfig({ ...cfg, vaults: list })
  if (list.find((v) => v.id === id)?.path === dataDir()) setVaultName(name)
}
