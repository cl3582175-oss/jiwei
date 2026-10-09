import { describe, it, expect } from 'vitest'
import { startPhoneServer, MAX_BYTES } from '../../services/capture/phoneServer'
import { parseForeground, detailPermission } from '../../services/capture/foreground'
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
async function session(options: { limit?: number; lifetime?: number; receive?: () => Promise<void> } = {}) {
  return startPhoneServer({
    host: '127.0.0.1',
    limit: options.limit,
    lifetime: options.lifetime,
    decode: async () => true,
    receive: async () => {
      await options.receive?.()
    }
  })
}
const upload = (url: string, body: BodyInit = png, extra: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('../../escape.png'), ...extra },
    body
  })
describe('phone HTTP boundary', () => {
  it('authenticates all routes, disables caching and stops on expiration', async () => {
    const s = await session({ lifetime: 100 })
    expect((await fetch(s.url.replace(/.$/, 'x'))).status).toBe(404)
    const r = await fetch(s.url)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await r.text()).toContain('capture="environment"')
    await new Promise((r) => setTimeout(r, 150))
    await expect(fetch(s.url)).rejects.toThrow()
    await s.stop()
  })
  it('rejects MIME mismatch, invalid signatures, oversize streams and keeps filenames as metadata', async () => {
    const s = await session()
    try {
      expect((await upload(s.url, png, { 'Content-Type': 'image/jpeg' })).status).toBe(415)
      expect((await upload(s.url, 'invalid')).status).toBe(415)
      expect((await upload(s.url, new Uint8Array(MAX_BYTES + 1))).status).toBe(413)
      expect((await upload(s.url)).status).toBe(201)
    } finally {
      await s.stop()
    }
  })
  it('reserves concurrent uploads and releases failed reservations', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const s = await session({ limit: 1, receive: () => gate })
    try {
      expect((await upload(s.url, 'invalid')).status).toBe(415)
      const pending = upload(s.url)
      await new Promise((r) => setTimeout(r, 25))
      expect((await upload(s.url)).status).toBe(429)
      release()
      expect((await pending).status).toBe(201)
      expect((await upload(s.url)).status).toBe(429)
    } finally {
      release()
      await s.stop()
    }
  })
})
it('parses foreground safely and remembers denied detail access', () => {
  expect(parseForeground('Safari\nReading\nhttps://example.com')).toEqual({ app: 'Safari' })
  expect(parseForeground('Finder\nTitle\nfile:///private')).toEqual({ app: 'Finder' })
  expect(detailPermission(true, true)).toBe(false)
  expect(detailPermission(false, false)).toBe(false)
})

it('rejects decoder failures including HEIC and does not call the receiver', async () => {
  let received = false
  const s = await startPhoneServer({
    host: '127.0.0.1',
    decode: async () => false,
    receive: async () => {
      received = true
    }
  })
  try {
    expect((await upload(s.url)).status).toBe(415)
    expect(received).toBe(false)
  } finally {
    await s.stop()
  }
})
it('treats traversal, absolute paths and Windows names solely as display metadata', async () => {
  const received: string[] = []
  const s = await startPhoneServer({
    host: '127.0.0.1',
    decode: async () => true,
    receive: async (f) => {
      received.push(f.name)
      expect(f.ext).toBe('png')
    }
  })
  try {
    for (const name of ['../escape.png', '/tmp/escape.png', 'C:\\temp\\escape.png'])
      expect((await upload(s.url, png, { 'X-Filename': encodeURIComponent(name) })).status).toBe(201)
    expect(received).toHaveLength(3)
  } finally {
    await s.stop()
  }
})
it('enforces the production 50-file total', async () => {
  const s = await session()
  try {
    for (let i = 0; i < 50; i++) expect((await upload(s.url)).status).toBe(201)
    expect((await upload(s.url)).status).toBe(429)
  } finally {
    await s.stop()
  }
})

it('bounds chunked requests without Content-Length and releases aborted reservations', async () => {
  const { request } = await import('node:http')
  const s = await session({ limit: 1 })
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(s.url, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Filename': 'large.png' } }, (res) => {
        res.resume()
        resolve(res.statusCode!)
      })
      req.on('error', reject)
      req.write(png)
      for (let i = 0; i < 26; i++) req.write(Buffer.alloc(1024 * 1024))
      req.end()
    })
    expect(status).toBe(413)
    await new Promise<void>((resolve) => {
      const req = request(s.url, { method: 'POST', headers: { 'Content-Type': 'image/png' } }, (res) => res.resume())
      req.on('error', () => resolve())
      req.write(png)
      setTimeout(() => req.destroy(), 20)
    })
    await new Promise((r) => setTimeout(r, 20))
    expect((await upload(s.url)).status).toBe(201)
  } finally {
    await s.stop()
  }
})
