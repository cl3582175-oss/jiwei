import { captureMessage, type CaptureMessageKey } from '@shared/captureMessages'
const text = (key: CaptureMessageKey): string => captureMessage('zh-CN', key)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { phonePage } from './phonePage'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export const MAX_BYTES = 25 * 1024 * 1024
export const MAX_AUDIO_BYTES = 300 * 1024 * 1024
export interface ReceivedAudio {
  path: string
  mime: string
  ext: string
  name: string
  note: string
  sessionId: string
}
export interface ReceivedFile {
  bytes: Buffer
  mime: string
  ext: string
  name: string
  note: string
  sessionId: string
}
interface Options {
  host: string
  lifetime?: number
  limit?: number
  decode: (bytes: Buffer, mime: string) => Promise<boolean>
  receive: (file: ReceivedFile) => Promise<void>
  decodeAudio?: (path: string, mime: string) => Promise<boolean>
  receiveAudio?: (file: ReceivedAudio) => Promise<void>
  changed?: (received: number) => void
}
const formats = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/webm': 'webm'
} as const
export function signature(b: Buffer, mime: string): boolean {
  if (mime === 'audio/mp4') return b.toString('ascii', 4, 8) === 'ftyp'
  if (mime === 'audio/mpeg') return b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224)
  if (mime === 'audio/wav') return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
  if (mime === 'audio/webm') return b.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))
  if (mime === 'image/png') return b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (mime === 'image/jpeg') return b[0] === 255 && b[1] === 216 && b[2] === 255
  if (mime === 'image/webp') return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  if (mime === 'application/pdf') return b.toString('ascii', 0, 5) === '%PDF-'
  return b.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1)$/.test(b.toString('ascii', 8, 12))
}
function header(req: IncomingMessage, key: string, max: number): string {
  const value = req.headers[key]
  try {
    return typeof value === 'string' ? decodeURIComponent(value).slice(0, max) : ''
  } catch {
    return ''
  }
}
export async function startPhoneServer(options: Options) {
  const token = randomBytes(32).toString('base64url'),
    sessionId = randomUUID(),
    expiresAt = Date.now() + (options.lifetime ?? 900_000)
  let count = 0,
    reserved = 0,
    stopped = false
  const inFlight = new Set<Promise<void>>()
  const reply = (res: ServerResponse, code: number, message: string): void => {
    res.writeHead(code)
    res.end(message)
  }
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    )
    const supplied = (req.url ?? '').match(/^\/u\/([A-Za-z0-9_-]{43})$/)?.[1] ?? ''
    if (
      stopped ||
      Date.now() >= expiresAt ||
      supplied.length !== token.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      reply(res, 404, text('phoneNotFound'))
      req.resume()
      return
    }
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      reply(res, 200, phonePage)
      return
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    if (req.method !== 'POST') {
      reply(res, 404, text('phoneNotFound'))
      req.resume()
      return
    }
    // 同源页面之外不接收跨站请求；随机令牌仍是所有请求的认证边界。
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      reply(res, 404, text('phoneNotFound'))
      req.resume()
      return
    }
    if (count + reserved >= (options.limit ?? 50)) {
      reply(res, 429, text('phoneLimit'))
      req.resume()
      return
    }
    const audio = typeof req.headers['content-type'] === 'string' && req.headers['content-type'].startsWith('audio/')
    const maxBytes = audio ? MAX_AUDIO_BYTES : MAX_BYTES
    if (Number(req.headers['content-length']) > maxBytes) {
      reply(res, 413, text('phoneTooLarge'))
      req.resume()
      return
    }
    const mime = req.headers['content-type'] ?? '',
      ext = formats[mime as keyof typeof formats]
    const name = header(req, 'x-filename', 250),
      note = header(req, 'x-note', 2000)
    const suffix = /\.([^.\\/]+)$/.exec(name)?.[1].toLowerCase()
    if (!ext || (suffix && !(suffix === ext || (ext === 'jpg' && suffix === 'jpeg')))) {
      reply(res, 415, text('phoneUnsupported'))
      req.resume()
      return
    }
    reserved++
    const operation = (async () => {
      let temp: string | null = null
      try {
        if (audio) {
          if (!options.decodeAudio || !options.receiveAudio) {
            reply(res, 415, text('phoneUnsupported'))
            req.resume()
            return
          }
          temp = await mkdtemp(join(tmpdir(), 'jiwei-phone-audio-'))
          const path = join(temp, `audio.${ext}`),
            file = await open(path, 'wx', 0o600)
          let head = Buffer.alloc(0),
            size = 0
          try {
            for await (const chunk of req) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
              size += bytes.length
              if (size > maxBytes) {
                reply(res, 413, text('phoneTooLarge'))
                return
              }
              if (head.length < 64) head = Buffer.concat([head, bytes.subarray(0, 64 - head.length)])
              await file.writeFile(bytes)
            }
          } finally {
            await file.close()
          }
          if (stopped || Date.now() >= expiresAt) {
            reply(res, 404, text('phoneNotFound'))
            return
          }
          if (!signature(head, mime) || !(await options.decodeAudio(path, mime))) {
            reply(res, 415, text('phoneDecode'))
            return
          }
          if (stopped || Date.now() >= expiresAt) {
            reply(res, 404, text('phoneNotFound'))
            return
          }
          await options.receiveAudio({ path, mime, ext, name, note, sessionId })
          count++
          options.changed?.(count)
          reply(res, 201, text('phoneReceived'))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          size += bytes.length
          if (size > MAX_BYTES) {
            reply(res, 413, text('phoneTooLarge'))
            return
          }
          chunks.push(bytes)
        }
        const bytes = Buffer.concat(chunks)
        if (stopped || Date.now() >= expiresAt) {
          reply(res, 404, text('phoneNotFound'))
          return
        }
        if (!signature(bytes, mime) || !(await options.decode(bytes, mime))) {
          reply(res, 415, text('phoneDecode'))
          return
        }
        if (stopped || Date.now() >= expiresAt) {
          reply(res, 404, text('phoneNotFound'))
          return
        }
        await options.receive({ bytes, mime, ext, name, note, sessionId })
        count++
        options.changed?.(count)
        reply(res, 201, text('phoneReceived'))
      } catch {
        if (!res.headersSent && !res.destroyed) reply(res, 400, text('phoneIncomplete'))
      } finally {
        if (temp) await rm(temp, { recursive: true, force: true })
        reserved--
      }
    })()
    inFlight.add(operation)
    void operation.finally(() => inFlight.delete(operation))
  })
  server.requestTimeout = 60_000
  server.headersTimeout = 15_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(text('phoneListener'))
  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopped = true
    clearTimeout(timer)
    server.closeAllConnections()
    stopping = (async () => {
      await new Promise<void>((r) => server.close(() => r()))
      await Promise.allSettled([...inFlight])
    })()
    return stopping
  }
  const timer = setTimeout(() => void stop(), Math.max(1, expiresAt - Date.now()))
  timer.unref()
  return {
    url: `http://${options.host}:${address.port}/u/${token}`,
    sessionId,
    expiresAt,
    stop,
    count: () => count,
    active: () => !stopped
  }
}
