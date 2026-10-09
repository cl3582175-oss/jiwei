import { networkInterfaces } from 'node:os'
import { nativeImage } from 'electron'
import { PDFDocument } from 'pdf-lib'
import QRCode from 'qrcode'
import { startPhoneServer } from './capture/phoneServer'
import { importBytes } from './assets'
import { create } from './inbox'
import type { PhoneStatus } from '@shared/capture'
let session: Awaited<ReturnType<typeof startPhoneServer>> | null = null
const stopping = new Set<Promise<void>>()
let qr = '',
  starting: Promise<PhoneStatus> | null = null
export function status(): PhoneStatus | null {
  return session
    ? {
        sessionId: session.sessionId,
        url: session.url,
        qr,
        expiresAt: session.expiresAt,
        received: session.count(),
        active: session.active()
      }
    : null
}
export async function stop(id: string): Promise<void> {
  if (session?.sessionId === id) {
    const old = session
    session = null
    qr = ''
    const operation = old.stop()
    stopping.add(operation)
    try {
      await operation
    } finally {
      stopping.delete(operation)
    }
  }
}
export async function start(): Promise<PhoneStatus> {
  const pending = (starting ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      if (session) await stop(session.sessionId)
      const host = Object.values(networkInterfaces())
        .flat()
        .find((a) => a?.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address
      if (!host) throw new Error('capture.noNetwork')
      const next = await startPhoneServer({
        host,
        decode: async (bytes, mime) => {
          try {
            if (mime === 'application/pdf') {
              await PDFDocument.load(bytes)
              return true
            }
            return !nativeImage.createFromBuffer(bytes).isEmpty()
          } catch {
            return false
          }
        },
        receive: async ({ bytes, mime, ext, note, name, sessionId }) => {
          // 外部名称只显示，素材路径完全由内容哈希生成。
          const heic = mime === 'image/heic'
          const asset = await importBytes(
            heic ? 'upload.png' : `upload.${ext}`,
            heic ? 'image/png' : mime,
            heic ? nativeImage.createFromBuffer(bytes).toPNG() : bytes
          )
          create({
            kind: 'photo',
            text: [note, name].filter(Boolean).join('\n'),
            assetId: asset.id,
            origin: { device: 'phone', sessionId }
          })
        }
      })
      session = next
      try {
        const code = await QRCode.toDataURL(next.url)
        if (session !== next || !next.active()) throw new Error('capture.expired')
        qr = code
        return status()!
      } catch (e) {
        await next.stop()
        if (session === next) session = null
        throw e
      }
    })
  starting = pending
  try {
    return await pending
  } finally {
    if (starting === pending) starting = null
  }
}
export async function shutdown(): Promise<void> {
  if (starting) await starting.catch(() => undefined)
  if (session) await stop(session.sessionId)
  await Promise.allSettled([...stopping])
}
