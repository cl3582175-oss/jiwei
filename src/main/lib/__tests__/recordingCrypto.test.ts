import { it, expect, afterEach } from 'vitest'
import { randomBytes } from 'crypto'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { encryptRecordingFile, encryptRecordingBytes, decryptRecordingRange, decryptRecordingFile, RECORDING_BLOCK_SIZE as BLOCK, RECORDING_HEADER_SIZE as HEADER, recoveryCode, normalizeRecoveryCode, wrapRecovery, unwrapRecovery } from '../recordingCrypto'

const roots: string[] = []
const dir = async (): Promise<string> => { const path = await mkdtemp(join(tmpdir(), 'jiwei-crypto-')); roots.push(path); return path }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function bytes(file: string, key: Buffer, id: Buffer, start = 0, end?: number): Promise<Buffer> { const out: Buffer[] = []; for await (const part of decryptRecordingRange(file, key, id, start, end)) out.push(part); return Buffer.concat(out) }
it('round trips files and arbitrary ranges across blocks, including empty files', async () => {
  const root = await dir(), plain = join(root, 'plain'), encrypted = join(root, 'encrypted'), decrypted = join(root, 'decrypted'), key = randomBytes(32), id = randomBytes(16), value = randomBytes(BLOCK * 3 + 19)
  await writeFile(plain, value); await encryptRecordingFile(plain, encrypted, key, id)
  expect(await bytes(encrypted, key, id)).toEqual(value)
  for (const [start, end] of [[0, 0], [2, BLOCK + 33], [BLOCK - 2, BLOCK * 2 + 11], [value.length - 7, value.length - 1]]) expect(await bytes(encrypted, key, id, start, end)).toEqual(value.subarray(start, end + 1))
  await decryptRecordingFile(encrypted, decrypted, key, id); expect(await readFile(decrypted)).toEqual(value)
  const empty = join(root, 'empty'); await encryptRecordingBytes(new Uint8Array(), empty, key, id); expect(await bytes(empty, key, id)).toEqual(Buffer.alloc(0))
})
it('rejects byte changes, reordered blocks, truncated final blocks, header tampering and wrong key identity', async () => {
  const file = join(await dir(), 'encrypted'), key = randomBytes(32), id = randomBytes(16)
  await encryptRecordingBytes(randomBytes(BLOCK * 3), file, key, id); const original = await readFile(file)
  const changed = Buffer.from(original); changed[HEADER + 30] ^= 1
  await writeFile(file, changed); await expect(bytes(file, key, id)).rejects.toThrow(/校验失败/)
  const swapped = Buffer.from(original), width = BLOCK + 16
  original.copy(swapped, HEADER, HEADER + width, HEADER + width * 2); original.copy(swapped, HEADER + width, HEADER, HEADER + width)
  await writeFile(file, swapped); await expect(bytes(file, key, id)).rejects.toThrow(/校验失败/)
  await writeFile(file, original.subarray(0, -width)); await expect(bytes(file, key, id)).rejects.toThrow(/不完整/)
  const truncated = Buffer.from(original.subarray(0, -width)); truncated.writeBigUInt64BE(BigInt(BLOCK * 2), 11)
  await writeFile(file, truncated); await expect(bytes(file, key, id)).rejects.toThrow(/校验失败/)
  await writeFile(file, original); await expect(bytes(file, key, randomBytes(16))).rejects.toThrow(/密钥不匹配/)
})
it('generates 24-character Crockford codes, corrects ambiguous letters, wraps with fixed scrypt, rejects a wrong code', async () => {
  const code = recoveryCode(), key = randomBytes(32), id = randomBytes(16)
  expect(code).toMatch(/^(?:[0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/)
  expect(normalizeRecoveryCode('oooo-iiii-llll-0000-1111-abcd')).toBe('00001111111100001111ABCD')
  expect(() => normalizeRecoveryCode('invalid')).toThrow()
  const envelope = await wrapRecovery(key, code, id)
  expect(envelope.N).toBe(2 ** 17); expect(await unwrapRecovery(envelope, code.toLowerCase())).toEqual(key)
  await expect(unwrapRecovery(envelope, recoveryCode())).rejects.toThrow(/不正确/)
  await expect(unwrapRecovery({ ...envelope, N: 2 ** 30 }, code)).rejects.toThrow(/格式/)
}, 15000)
