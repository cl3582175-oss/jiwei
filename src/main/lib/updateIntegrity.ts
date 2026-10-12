import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'

export async function verifyUpdateSha512(file: string, expected: string): Promise<void> {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(expected)) throw new Error('Invalid SHA-512 checksum')
  const want = Buffer.from(expected, 'base64')
  if (want.length !== 64) throw new Error('Invalid SHA-512 checksum')
  const digest = createHash('sha512')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  if (!timingSafeEqual(digest.digest(), want)) throw new Error('SHA-512 checksum mismatch')
}
