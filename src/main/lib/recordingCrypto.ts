import { tr } from './messages'
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto'
import { open } from 'fs/promises'
import { writeAll } from './tar'

export const RECORDING_HEADER_SIZE = 47
export const RECORDING_BLOCK_SIZE = 65536
const MAGIC = 'JWREC1',
  ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export interface RecordingHeader {
  bytes: Buffer
  blockSize: number
  size: number
  nonce: Buffer
  keyId: Buffer
}
export interface RecoveryEnvelope {
  version: 1
  salt: string
  N: number
  r: number
  p: number
  nonce: string
  ciphertext: string
  tag: string
  keyId: string
}
export function recoveryCode(): string {
  return [...randomBytes(24)]
    .map((b) => ALPHABET[b & 31])
    .join('')
    .match(/.{4}/g)!
    .join('-')
}
export function normalizeRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (normalized.length !== 24 || [...normalized].some((c) => !ALPHABET.includes(c))) throw new Error(tr('请输入完整的 6 组恢复码', 'Enter all 6 groups of the recovery code'))
  return normalized
}
const derive = (code: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(normalizeRecoveryCode(code), salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key)
    )
  })
export async function wrapRecovery(dek: Buffer, code: string, keyId: Buffer): Promise<RecoveryEnvelope> {
  const salt = randomBytes(16),
    nonce = randomBytes(12),
    kek = await derive(code, salt)
  try {
    const cipher = createCipheriv('aes-256-gcm', kek, nonce)
    cipher.setAAD(keyId)
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()])
    return {
      version: 1,
      salt: salt.toString('base64'),
      N: 2 ** 17,
      r: 8,
      p: 1,
      nonce: nonce.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      keyId: keyId.toString('hex')
    }
  } finally {
    kek.fill(0)
  }
}
export async function unwrapRecovery(value: RecoveryEnvelope, code: string): Promise<Buffer> {
  if (value.version !== 1 || value.N !== 2 ** 17 || value.r !== 8 || value.p !== 1 || !/^[a-f0-9]{32}$/.test(value.keyId))
    throw new Error(tr('恢复密钥格式不正确', 'The recovery key format is invalid'))
  const salt = Buffer.from(value.salt, 'base64'),
    nonce = Buffer.from(value.nonce, 'base64'),
    tag = Buffer.from(value.tag, 'base64'),
    encrypted = Buffer.from(value.ciphertext, 'base64')
  if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16 || encrypted.length !== 32) throw new Error(tr('恢复密钥格式不正确', 'The recovery key format is invalid'))
  const kek = await derive(code, salt)
  try {
    const cipher = createDecipheriv('aes-256-gcm', kek, nonce)
    cipher.setAAD(Buffer.from(value.keyId, 'hex'))
    cipher.setAuthTag(tag)
    return Buffer.concat([cipher.update(encrypted), cipher.final()])
  } catch {
    throw new Error(tr('恢复码不正确，请核对后重试', 'Incorrect recovery code. Check it and try again.'))
  } finally {
    kek.fill(0)
  }
}
function blockNonce(base: Buffer, index: number): Buffer {
  const nonce = Buffer.from(base)
  nonce.writeBigUInt64BE(nonce.readBigUInt64BE(4) ^ BigInt(index), 4)
  return nonce
}
function aad(header: Buffer, index: number, last: boolean): Buffer {
  const tail = Buffer.alloc(9)
  tail.writeBigUInt64BE(BigInt(index))
  tail[8] = Number(last)
  return Buffer.concat([header, tail])
}
export function parseRecordingHeader(bytes: Buffer, encryptedSize: number): RecordingHeader {
  if (bytes.length !== RECORDING_HEADER_SIZE || bytes.toString('ascii', 0, 6) !== MAGIC || bytes[6] !== 1)
    throw new Error(tr('录音文件头已损坏', 'The recording file header is damaged'))
  const blockSize = bytes.readUInt32BE(7),
    size = Number(bytes.readBigUInt64BE(11))
  if (
    blockSize !== RECORDING_BLOCK_SIZE ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    encryptedSize !== RECORDING_HEADER_SIZE + size + Math.max(1, Math.ceil(size / blockSize)) * 16
  )
    throw new Error(tr('录音文件不完整或已损坏', 'The recording file is incomplete or damaged'))
  return { bytes, blockSize, size, nonce: bytes.subarray(19, 31), keyId: bytes.subarray(31, 47) }
}
export async function recordingHeader(file: string): Promise<RecordingHeader> {
  const handle = await open(file, 'r')
  try {
    const bytes = Buffer.alloc(RECORDING_HEADER_SIZE),
      result = await handle.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead !== bytes.length) throw new Error(tr('录音文件不完整', 'The recording file is incomplete'))
    return parseRecordingHeader(bytes, (await handle.stat()).size)
  } finally {
    await handle.close()
  }
}
export async function encryptRecordingFile(
  input: string,
  output: string,
  dek: Buffer,
  keyId: Buffer,
  signal?: AbortSignal,
  progress?: (n: number) => void
): Promise<void> {
  const src = await open(input, 'r'),
    dst = await open(output, 'wx', 0o600)
  try {
    const { size } = await src.stat(),
      header = Buffer.alloc(RECORDING_HEADER_SIZE),
      nonce = randomBytes(12)
    header.write(MAGIC)
    header[6] = 1
    header.writeUInt32BE(RECORDING_BLOCK_SIZE, 7)
    header.writeBigUInt64BE(BigInt(size), 11)
    nonce.copy(header, 19)
    keyId.copy(header, 31)
    await writeAll(dst, header)
    for (let i = 0; i < Math.max(1, Math.ceil(size / RECORDING_BLOCK_SIZE)); i++) {
      signal?.throwIfAborted()
      const length = Math.min(RECORDING_BLOCK_SIZE, size - i * RECORDING_BLOCK_SIZE),
        plain = Buffer.alloc(length)
      try {
        if ((await src.read(plain, 0, length, i * RECORDING_BLOCK_SIZE)).bytesRead !== length) throw new Error(tr('录音在加密时已改变', 'The recording changed during encryption'))
        const cipher = createCipheriv('aes-256-gcm', dek, blockNonce(nonce, i))
        cipher.setAAD(aad(header, i, (i + 1) * RECORDING_BLOCK_SIZE >= size))
        await writeAll(dst, Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]))
        progress?.(length)
      } finally {
        plain.fill(0)
      }
    }
    await dst.sync()
  } finally {
    await src.close()
    await dst.close()
  }
}
export async function encryptRecordingBytes(bytes: Uint8Array, output: string, dek: Buffer, keyId: Buffer): Promise<void> {
  const dst = await open(output, 'wx', 0o600)
  try {
    const header = Buffer.alloc(RECORDING_HEADER_SIZE),
      nonce = randomBytes(12)
    header.write(MAGIC)
    header[6] = 1
    header.writeUInt32BE(RECORDING_BLOCK_SIZE, 7)
    header.writeBigUInt64BE(BigInt(bytes.length), 11)
    nonce.copy(header, 19)
    keyId.copy(header, 31)
    await writeAll(dst, header)
    for (let i = 0; i < Math.max(1, Math.ceil(bytes.length / RECORDING_BLOCK_SIZE)); i++) {
      const cipher = createCipheriv('aes-256-gcm', dek, blockNonce(nonce, i))
      cipher.setAAD(aad(header, i, (i + 1) * RECORDING_BLOCK_SIZE >= bytes.length))
      await writeAll(
        dst,
        Buffer.concat([
          cipher.update(bytes.subarray(i * RECORDING_BLOCK_SIZE, (i + 1) * RECORDING_BLOCK_SIZE)),
          cipher.final(),
          cipher.getAuthTag()
        ])
      )
    }
    await dst.sync()
  } finally {
    await dst.close()
  }
}
/** 只解密请求覆盖的块；物理长度和每块标签均校验。 */
export async function* decryptRecordingRange(
  file: string,
  dek: Buffer,
  keyId: Buffer,
  start = 0,
  end?: number,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  const src = await open(file, 'r')
  try {
    const headerBytes = Buffer.alloc(RECORDING_HEADER_SIZE)
    if ((await src.read(headerBytes, 0, headerBytes.length, 0)).bytesRead !== headerBytes.length) throw new Error(tr('录音文件不完整', 'The recording file is incomplete'))
    const header = parseRecordingHeader(headerBytes, (await src.stat()).size)
    if (!header.keyId.equals(keyId)) throw new Error(tr('录音密钥不匹配，请输入恢复码', 'Recording key mismatch; enter the recovery code'))
    const last = end ?? header.size - 1
    if (header.size && (!Number.isSafeInteger(start) || !Number.isSafeInteger(last) || start < 0 || last < start || last >= header.size))
      throw new Error(tr('录音播放范围无效', 'Invalid playback range'))
    for (let i = Math.floor(start / header.blockSize); i <= Math.max(0, Math.floor(last / header.blockSize)); i++) {
      signal?.throwIfAborted()
      const length = Math.min(header.blockSize, header.size - i * header.blockSize),
        encrypted = Buffer.alloc(length + 16)
      if (
        (await src.read(encrypted, 0, encrypted.length, RECORDING_HEADER_SIZE + i * (header.blockSize + 16))).bytesRead !== encrypted.length
      )
        throw new Error(tr('录音文件不完整', 'The recording file is incomplete'))
      let plain: Buffer
      try {
        const cipher = createDecipheriv('aes-256-gcm', dek, blockNonce(header.nonce, i))
        cipher.setAAD(aad(headerBytes, i, (i + 1) * header.blockSize >= header.size))
        cipher.setAuthTag(encrypted.subarray(length))
        plain = Buffer.concat([cipher.update(encrypted.subarray(0, length)), cipher.final()])
      } catch {
        throw new Error(tr('录音校验失败，文件可能已损坏', 'Recording verification failed; the file may be damaged'))
      }
      try {
        yield Buffer.from(plain.subarray(Math.max(0, start - i * header.blockSize), Math.min(length, last - i * header.blockSize + 1)))
      } finally {
        plain.fill(0)
      }
    }
  } finally {
    await src.close()
  }
}
export async function decryptRecordingFile(
  input: string,
  output: string,
  dek: Buffer,
  keyId: Buffer,
  signal?: AbortSignal,
  progress?: (n: number) => void
): Promise<void> {
  const dst = await open(output, 'wx', 0o600)
  try {
    for await (const plain of decryptRecordingRange(input, dek, keyId, 0, undefined, signal)) {
      try {
        await writeAll(dst, plain)
        progress?.(plain.length)
      } finally {
        plain.fill(0)
      }
    }
    await dst.sync()
  } finally {
    await dst.close()
  }
}
