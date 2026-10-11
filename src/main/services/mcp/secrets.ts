import { safeStorage } from 'electron'
import { tr } from '../../lib/messages'

// 外部服务器的环境变量、请求头、OAuth 令牌：用系统钥匙串加密后存入数据库，不写日志、不回传界面。

export function sealJson(value: unknown): Buffer {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(tr('系统钥匙串不可用，无法安全保存凭证', 'The system keychain is unavailable; credentials cannot be stored safely'))
  return safeStorage.encryptString(JSON.stringify(value))
}

export function openJson<T>(blob: Buffer | null | undefined, fallback: T): T {
  if (!blob) return fallback
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(blob))) as T
  } catch {
    return fallback
  }
}
