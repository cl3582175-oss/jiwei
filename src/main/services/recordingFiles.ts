import { tr } from '../lib/messages'
import { app, safeStorage } from 'electron'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, rename, writeFile, stat } from 'fs/promises'
import { randomBytes, createHash } from 'crypto'
import { join } from 'path'
import { dataDir, getSqlite } from '../db'
import { deviceId } from './device'
import {
  decryptRecordingFile,
  decryptRecordingRange,
  encryptRecordingFile,
  encryptRecordingBytes,
  recordingHeader,
  recoveryCode,
  normalizeRecoveryCode,
  wrapRecovery,
  unwrapRecovery,
  type RecoveryEnvelope
} from '../lib/recordingCrypto'
import { copySafeFile, filesIn, fileHash, withRecordingStore } from '../lib/safetyFiles'
import { SafetyOperation } from './safetyProgress'
import type { RecordingCryptoStatus } from '@shared/backup'

export const recordingsDir = (): string => join(dataDir(), 'recordings')
export const recordingFolder = (id: string): string => {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error(tr('录音编号无效', 'Invalid recording id'))
  return join(recordingsDir(), id)
}
export const cryptoOperation = new SafetyOperation()
const metaGet = (key: string): string | null =>
  (getSqlite().prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null
const metaSet = (key: string, value: string): void => {
  getSqlite().prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(key, value)
}
let key: { dek: Buffer; id: Buffer } | null = null
let prepared: { code: string; dek: Buffer; id: Buffer; envelope: RecoveryEnvelope; expires: number } | null = null
const available = (): boolean =>
  safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
export const encryptionMode = (): 'on' | 'off' | 'unset' => {
  const mode = metaGet('recording.encryption')
  return mode === 'on' || mode === 'off' ? mode : 'unset'
}
export function recordingKey(): { dek: Buffer; id: Buffer } {
  if (key) return key
  const local = metaGet(`recording.key.device:${deviceId()}`),
    envelope = metaGet('recording.key.recovery')
  if (local && envelope && available()) {
    try {
      const dek = Buffer.from(safeStorage.decryptString(Buffer.from(local, 'base64')), 'base64'),
        id = Buffer.from((JSON.parse(envelope) as RecoveryEnvelope).keyId, 'hex')
      if (dek.length === 32 && id.length === 16) {
        key = { dek, id }
        return key
      }
      dek.fill(0)
    } catch {
      /* 另一台电脑或钥匙串被重置，必须恢复码解锁。 */
    }
  }
  throw new Error(tr('请先输入恢复码解锁录音', 'Enter the recovery code to unlock recordings'))
}
export function cryptoStatus(): RecordingCryptoStatus {
  let unlocked = encryptionMode() !== 'on'
  if (metaGet('recording.key.recovery')) {
    try {
      recordingKey()
      unlocked = true
    } catch {
      unlocked = false
    }
  }
  return {
    available: available(),
    reason: available() ? null : tr('系统钥匙串不可用，暂时无法安全加密录音。录音将保持明文。', 'The system keychain is unavailable, so recordings cannot be encrypted safely. They stay unencrypted.'),
    encryption: encryptionMode(),
    unlocked,
    progress: cryptoOperation.value
  }
}
function clearPrepared(): void {
  prepared?.dek.fill(0)
  prepared = null
}
export const cancelRecovery = (): void => clearPrepared()
export function clearRecordingKeys(): void {
  key?.dek.fill(0)
  key = null
  clearPrepared()
}
export async function prepareRecovery(): Promise<string> {
  if (cryptoOperation.running) throw new Error(tr('请先暂停录音迁移，再生成恢复码', 'Pause the recording migration before generating a recovery code'))
  if (!available()) throw new Error(tr('系统钥匙串不可用，无法启用录音加密', 'The system keychain is unavailable; recording encryption cannot be turned on'))
  clearPrepared()
  const existing = metaGet('recording.key.recovery') ? recordingKey() : null,
    dek = existing ? Buffer.from(existing.dek) : randomBytes(32),
    id = existing ? Buffer.from(existing.id) : randomBytes(16),
    code = recoveryCode()
  try {
    prepared = { code, dek, id, envelope: await wrapRecovery(dek, code, id), expires: Date.now() + 15 * 60_000 }
    return code
  } catch (error) {
    dek.fill(0)
    throw error
  }
}
export function pendingRecovery(): string {
  if (!prepared || prepared.expires < Date.now()) {
    clearPrepared()
    throw new Error(tr('恢复码已过期，请重新生成', 'The recovery code expired. Generate a new one.'))
  }
  return prepared.code
}
export function confirmRecovery(lastGroup: string): void {
  if (cryptoOperation.running) throw new Error(tr('请先暂停录音迁移，再确认恢复码', 'Pause the recording migration before confirming the recovery code'))
  const code = pendingRecovery(),
    p = prepared!
  if (lastGroup.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1') !== normalizeRecoveryCode(code).slice(-4))
    throw new Error(tr('最后一组不匹配，请核对已保存的恢复码', 'The last group does not match. Check the saved recovery code.'))
  if (!available()) throw new Error(tr('系统钥匙串不可用，未启用加密', 'The system keychain is unavailable; encryption was not turned on'))
  const encrypted = safeStorage.encryptString(p.dek.toString('base64')).toString('base64')
  getSqlite().transaction(() => {
    metaSet('recording.key.recovery', JSON.stringify(p.envelope))
    metaSet(`recording.key.device:${deviceId()}`, encrypted)
    metaSet('recording.encryption', 'on')
  })()
  key?.dek.fill(0)
  key = { dek: Buffer.from(p.dek), id: Buffer.from(p.id) }
  clearPrepared()
  resumeCryptoMigration()
}
export async function unlockRecordings(code: string): Promise<void> {
  const value = metaGet('recording.key.recovery')
  if (!value) throw new Error(tr('这个知识库没有恢复密钥', 'This vault has no recovery key'))
  const envelope = JSON.parse(value) as RecoveryEnvelope,
    dek = await unwrapRecovery(envelope, code)
  try {
    if (available()) metaSet(`recording.key.device:${deviceId()}`, safeStorage.encryptString(dek.toString('base64')).toString('base64'))
    key?.dek.fill(0)
    key = { dek: Buffer.from(dek), id: Buffer.from(envelope.keyId, 'hex') }
  } finally {
    dek.fill(0)
  }
  resumeCryptoMigration()
}
export function setRecordingEncryption(enabled: boolean, confirmed: boolean): void {
  if (cryptoOperation.running) throw new Error(tr('请先暂停正在进行的迁移', 'Pause the running migration first'))
  if (!enabled && !confirmed) throw new Error(tr('关闭加密需要再次确认', 'Turning off encryption needs confirmation'))
  if (enabled) {
    if (!available()) throw new Error(tr('系统钥匙串不可用', 'The system keychain is unavailable'))
    recordingKey()
  } else if (metaGet('recording.key.recovery')) recordingKey()
  metaSet('recording.encryption', enabled ? 'on' : 'off')
  resumeCryptoMigration()
}
export function deferRecordingEncryption(): void {
  if (encryptionMode() === 'unset') metaSet('recording.encryption', 'off')
}
export async function recordingTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = join(dataDir(), '.tmp')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(root, 'rec-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
export function storedRecordingFile(id: string, name: string): string | null {
  if (!/^(mix|mic|system)(?:-\d{6})?\.webm$/.test(name)) throw new Error(tr('录音文件名无效', 'Invalid recording file name'))
  const path = join(recordingFolder(id), name)
  return existsSync(path + '.enc') ? path + '.enc' : existsSync(path) ? path : null
}
export async function withRecordingPath<T>(id: string, name: string, fn: (file: string) => Promise<T>, storeLocked = false): Promise<T> {
  return recordingTemp(async (dir) => {
    const plain = join(dir, name)
    const prepare = async (): Promise<void> => {
      const file = storedRecordingFile(id, name)
      if (!file) throw new Error(tr('录音音频不存在', 'Recording audio not found'))
      if (!file.endsWith('.enc')) await copySafeFile(file, plain)
      else {
        const { dek, id: keyId } = recordingKey()
        await decryptRecordingFile(file, plain, dek, keyId)
      }
    }
    if (storeLocked) await prepare()
    else await withRecordingStore(prepare)
    return fn(plain)
  })
}
export async function publishRecordingFile(plain: string, destination: string): Promise<void> {
  if (encryptionMode() === 'on') {
    const { dek, id } = recordingKey(),
      tmp = destination + '.enc.tmp'
    await rm(tmp, { force: true })
    try {
      await encryptRecordingFile(plain, tmp, dek, id)
      await rename(tmp, destination + '.enc')
    } finally {
      await rm(tmp, { force: true })
    }
  } else {
    const tmp = destination + '.tmp'
    await rm(tmp, { force: true })
    try {
      await copySafeFile(plain, tmp)
      await rename(tmp, destination)
    } finally {
      await rm(tmp, { force: true })
    }
  }
}
export async function writeRecordingBytes(destination: string, bytes: Uint8Array): Promise<void> {
  if (encryptionMode() === 'on') {
    const { dek, id } = recordingKey(),
      tmp = destination + '.enc.tmp'
    await rm(tmp, { force: true })
    try {
      await encryptRecordingBytes(bytes, tmp, dek, id)
      await rename(tmp, destination + '.enc')
    } finally {
      await rm(tmp, { force: true })
    }
  } else {
    await writeFile(destination + '.tmp', bytes, { mode: 0o600 })
    await rename(destination + '.tmp', destination)
  }
}
export async function recordingStream(file: string, start: number, end: number): Promise<AsyncIterable<Buffer>> {
  const { dek, id } = recordingKey()
  return decryptRecordingRange(file, dek, id, start, end)
}
export async function recordingPlainSize(file: string): Promise<number> {
  return file.endsWith('.enc') ? (await recordingHeader(file)).size : (await stat(file)).size
}
/** 每个文件先验证再删除原件；重启后重新扫描，不依赖易丢失的进度游标。 */
export function resumeCryptoMigration(): void {
  if (cryptoOperation.running || !metaGet('recording.key.recovery')) return
  try {
    recordingKey()
  } catch {
    return
  }
  void cryptoOperation
    .run(
      tr('录音加密迁移', 'Recording encryption migration'),
      async (signal) => {
        const encrypt = encryptionMode() === 'on',
          files = (await filesIn(recordingsDir())).filter((f) => (encrypt ? /\.webm$/.test(f.path) : /\.webm\.enc$/.test(f.path))),
          total = files.reduce((n, f) => n + f.size, 0)
        let done = 0
        cryptoOperation.progress(0, total)
        cryptoOperation.value.message = encrypt ? tr('正在加密已有录音', 'Encrypting existing recordings') : tr('正在解密已有录音', 'Decrypting existing recordings')
        for (const f of files) {
          signal.throwIfAborted()
          await withRecordingStore(async () => {
            const source = join(recordingsDir(), f.path),
              target = encrypt ? source + '.enc' : source.slice(0, -4),
              { dek, id } = recordingKey(),
              tmp = target + '.tmp'
            // 等待互斥边界期间，用户可能已经删除了这条录音。
            if (!existsSync(source)) {
              cryptoOperation.progress((done += f.size))
              return
            }
            await rm(tmp, { force: true })
            try {
              if (encrypt) {
                await encryptRecordingFile(source, tmp, dek, id, signal, (n) => cryptoOperation.progress((done += n)))
                const expected = await fileHash(source, signal),
                  hash = createHash('sha256')
                for await (const b of decryptRecordingRange(tmp, dek, id, 0, undefined, signal)) {
                  hash.update(b)
                  b.fill(0)
                }
                if (expected !== hash.digest('hex')) throw new Error(tr('录音加密校验失败，原录音已保留', 'Encryption check failed; the original recording was kept'))
              } else {
                await decryptRecordingFile(source, tmp, dek, id, signal, (n) => cryptoOperation.progress((done += n)))
                const hash = createHash('sha256')
                for await (const b of decryptRecordingRange(source, dek, id, 0, undefined, signal)) {
                  hash.update(b)
                  b.fill(0)
                }
                if (hash.digest('hex') !== (await fileHash(tmp, signal))) throw new Error(tr('录音解密校验失败，原录音已保留', 'Decryption check failed; the original recording was kept'))
              }
              signal.throwIfAborted()
              await rename(tmp, target)
              await rm(source)
            } finally {
              await rm(tmp, { force: true })
            }
          })
        }
      },
      tr('已有录音迁移完成，可以继续录制和播放', 'Existing recordings migrated. You can keep recording and playing.')
    )
    .catch(() => {})
}
export async function initializeRecordingFiles(): Promise<void> {
  await rm(join(dataDir(), '.tmp'), { recursive: true, force: true })
  await mkdir(recordingsDir(), { recursive: true, mode: 0o700 })
  const rows = getSqlite().prepare('SELECT id FROM recordings').all() as { id: string }[]
  for (const { id } of rows) {
    const old = join(app.getPath('userData'), 'recordings', id),
      target = recordingFolder(id),
      partial = target + '.moving'
    if (!existsSync(old)) continue
    if (existsSync(target)) {
      // 复制已发布、删除旧位置前崩溃：只有逐项完全相同才清理旧位置。
      const files = await filesIn(old)
      if (
        files.length &&
        (await filesIn(target)).length === files.length &&
        (
          await Promise.all(
            files.map(
              async (f) =>
                existsSync(join(target, f.path)) && (await fileHash(join(old, f.path))) === (await fileHash(join(target, f.path)))
            )
          )
        ).every(Boolean)
      )
        await rm(old, { recursive: true })
      continue
    }
    try {
      await rename(old, target)
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
    await rm(partial, { recursive: true, force: true })
    await mkdir(partial, { mode: 0o700 })
    for (const f of await filesIn(old)) {
      await copySafeFile(join(old, f.path), join(partial, f.path))
      if (
        (await stat(join(partial, f.path))).size !== f.size ||
        (await fileHash(join(old, f.path))) !== (await fileHash(join(partial, f.path)))
      )
        throw new Error(tr('录音迁移校验失败，原文件已保留', 'Recording migration check failed; the original files were kept'))
    }
    await rename(partial, target)
    await rm(old, { recursive: true })
  }
}
