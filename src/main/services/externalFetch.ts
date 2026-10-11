import { app, net } from 'electron'

// 同域所有订阅与任务共用一条队列；不设置 UA，保持 Electron 默认身份。
const queues = new Map<string, Promise<void>>()
const completed = new Map<string, number>()
export function checkedWebUrl(value: string, httpsOnly = false): URL {
  const u = new URL(value.replace(/^webcal:/i, 'https:'))
  const fixture = !app.isPackaged && process.env.JIWEI_TEST_NETWORK === '1' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  if (u.username || u.password || !['https:', 'http:'].includes(u.protocol) || (httpsOnly && u.protocol !== 'https:' && !fixture))
    throw new Error('Invalid web address')
  return u
}

async function inDomain<T>(u: URL, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(u.hostname) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => {
    release = r
  })
  queues.set(u.hostname, next)
  await previous.catch(() => {})
  try {
    // 从上次完成后等待两秒，覆盖连接与响应延迟，确保请求开始间隔不少于两秒。
    const wait = (completed.get(u.hostname) ?? 0) + 2000 - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    return await fn()
  } finally {
    completed.set(u.hostname, Date.now())
    release()
    if (queues.get(u.hostname) === next) queues.delete(u.hostname)
  }
}

export async function externalFetch(
  value: string,
  options: { headers?: Record<string, string>; method?: string; body?: string; maxBytes?: number; httpsOnly?: boolean; validateUrl?: (url: string) => void; signal?: AbortSignal } = {}
): Promise<{ status: number; text: string; bytes: Uint8Array; headers: Headers }> {
  let u = checkedWebUrl(value, options.httpsOnly),
    headers = { ...options.headers },
    method = options.method ?? 'GET',
    body = options.body
  for (let redirect = 0; redirect <= 5; redirect++) {
    options.validateUrl?.(u.href)
    const response = await inDomain(u, async () => {
      options.signal?.throwIfAborted()
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
      const res = await net.fetch(u.href, { method, body, headers, credentials: 'omit', redirect: 'manual', signal })
      if (res.status >= 300 && res.status < 400 && res.status !== 304) return { status: res.status, text: '', bytes: new Uint8Array(), headers: res.headers }
      const max = options.maxBytes ?? 2 * 1024 * 1024
      if (Number(res.headers.get('content-length')) > max) throw new Error('Response too large')
      const reader = res.body?.getReader(),
        chunks: Uint8Array[] = []
      let length = 0
      if (reader)
        for (;;) {
          const c = await reader.read()
          if (c.done) break
          length += c.value.byteLength
          if (length > max) {
            await reader.cancel()
            throw new Error('Response too large')
          }
          chunks.push(c.value)
        }
      const data = new Uint8Array(length)
      let offset = 0
      for (const c of chunks) {
        data.set(c, offset)
        offset += c.length
      }
      return { status: res.status, text: new TextDecoder().decode(data), bytes: data, headers: res.headers }
    })
    if (!(response.status >= 300 && response.status < 400 && response.status !== 304)) return response
    const location = response.headers.get('location')
    if (!location) throw new Error('Invalid redirect')
    const next = checkedWebUrl(new URL(location, u).href, options.httpsOnly)
    if (next.origin !== u.origin)
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !['authorization', 'cookie', 'x-subscription-token', 'x-api-key'].includes(k.toLowerCase())))
    if ([301, 302, 303].includes(response.status) && method !== 'GET') {
      method = 'GET'
      body = undefined
    }
    u = next
  }
  throw new Error('Too many redirects')
}
