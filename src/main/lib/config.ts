import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

// 引导配置：保存在系统应用目录，只记录“数据目录在哪里”。
// 数据目录本身可由用户迁移到任意位置（设置 → 数据）。

interface BootConfig {
  dataDir?: string
}

const file = (): string => join(app.getPath('userData'), 'jiwei-config.json')

export function readBootConfig(): BootConfig {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as BootConfig) : {}
  } catch {
    return {}
  }
}

export function writeBootConfig(cfg: BootConfig): void {
  writeFileSync(file(), JSON.stringify(cfg, null, 2))
}

export function defaultDataDir(): string {
  return join(app.getPath('userData'), 'data')
}

/** 云同步盘会在 SQLite 写入中途同步文件，可能损坏数据库 */
const CLOUD_HINTS = [
  'Mobile Documents', // iCloud Drive
  'CloudStorage', // macOS 新版云盘挂载点
  'Dropbox',
  'OneDrive',
  'Google Drive',
  'GoogleDrive',
  'Nutstore',
  '坚果云',
  'BaiduNetdisk',
  '百度网盘',
  'iCloud'
]

export function looksLikeCloudFolder(p: string): boolean {
  return CLOUD_HINTS.some((h) => p.includes(h))
}
