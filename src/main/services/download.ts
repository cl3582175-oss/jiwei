import { net } from 'electron'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, rename, rm, stat } from 'fs/promises'
import { dirname } from 'path'
import log from 'electron-log/main'

// 多镜像下载器（大文件：模型、运行时）
//   1. 并行测速：每个镜像下载前 256KB，按速度排序，失败的镜像排除
//   2. 断点续传：写入 .part 文件，从已下载位置继续（HTTP Range）
//   3. 自动切换：持续低速（低于最快测速的 30% 且低于 200KB/s，持续 15 秒）则换下一个镜像续传
//   4. 完整性校验：下载完成后校验 sha256，不一致则删除并换镜像重试
// 使用 Electron net.fetch，遵循系统代理设置。

export interface DownloadSpec {
  /** 显示名 */
  name: string
  size: number
  sha256: string
  urls: string[]
  dest: string
}

export interface DownloadProgress {
  received: number
  total: number
  /** 字节 / 秒 */
  speed: number
  mirror: string
}

const PROBE_BYTES = 256 * 1024
const PROBE_TIMEOUT = 10_000
const SLOW_WINDOW = 15_000
const MIN_SPEED = 200 * 1024

const host = (u: string): string => {
  try {
    return new URL(u).hostname
  } catch {
    return u
  }
}

async function exists(p: string): Promise<number | null> {
  return stat(p).then(
    (s) => s.size,
    () => null
  )
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/** 测速：返回按速度从快到慢排列的可用镜像 */
export async function probeMirrors(urls: string[]): Promise<{ url: string; speed: number }[]> {
  const results = await Promise.all(
    urls.map(async (url) => {
      const t0 = Date.now()
      try {
        const res = await net.fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT) })
        if (!res.ok || !res.body) return null
        let n = 0
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          n += value.byteLength
          if (n >= PROBE_BYTES) {
            void reader.cancel()
            break
          }
        }
        return { url, speed: n / Math.max(0.05, (Date.now() - t0) / 1000) }
      } catch {
        return null
      }
    })
  )
  return results.filter((r): r is { url: string; speed: number } => !!r).sort((a, b) => b.speed - a.speed)
}

class SlowMirror extends Error {}

/** 从一个镜像下载（续传到 part 文件）；持续低速时抛出 SlowMirror */
async function fetchInto(
  url: string,
  part: string,
  spec: DownloadSpec,
  slowBelow: number,
  signal: AbortSignal,
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  const offset = (await exists(part)) ?? 0
  if (offset >= spec.size) return
  const ctrl = new AbortController()
  const abort = (): void => ctrl.abort()
  signal.addEventListener('abort', abort)
  try {
    const res = await net.fetch(url, { headers: { Range: `bytes=${offset}-` }, signal: ctrl.signal })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    // 服务器不支持 Range 时只能从头开始
    const resumed = res.status === 206
    const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
    let received = resumed ? offset : 0
    const samples: [number, number][] = [[Date.now(), received]]
    let slowSince: number | null = null
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        received += value.byteLength
        const now = Date.now()
        samples.push([now, received])
        while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift()
        const speed = (received - samples[0][1]) / Math.max(0.2, (now - samples[0][0]) / 1000)
        onProgress({ received, total: spec.size, speed, mirror: host(url) })
        if (now - samples[0][0] >= 4000 && speed < slowBelow) {
          slowSince ??= now
          if (now - slowSince > SLOW_WINDOW) throw new SlowMirror(host(url))
        } else slowSince = null
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
  } finally {
    signal.removeEventListener('abort', abort)
    ctrl.abort()
  }
}

export async function download(
  spec: DownloadSpec,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  if ((await exists(spec.dest)) === spec.size && (await sha256File(spec.dest)) === spec.sha256) return
  await mkdir(dirname(spec.dest), { recursive: true })
  const part = `${spec.dest}.part`
  const ranked = await probeMirrors(spec.urls)
  log.info('[download]', spec.name, 'mirrors', ranked.map((r) => `${host(r.url)} ${(r.speed / 1024).toFixed(0)}KB/s`).join(', '))
  if (ranked.length === 0) throw new Error(`所有下载源都无法连接（${spec.urls.map(host).join('、')}）`)
  const slowBelow = Math.min(MIN_SPEED, ranked[0].speed * 0.3)

  const errors: string[] = []
  // 每个镜像最多尝试两轮（低速切换后可能再回来）
  const queue = [...ranked, ...ranked]
  for (const { url } of queue) {
    if (signal.aborted) throw new Error('已取消')
    try {
      await fetchInto(url, part, spec, slowBelow, signal, onProgress)
      if ((await exists(part)) !== spec.size) throw new Error('文件大小不符')
      if ((await sha256File(part)) !== spec.sha256) {
        await rm(part, { force: true })
        throw new Error('校验失败（sha256 不一致）')
      }
      await rename(part, spec.dest)
      log.info('[download]', spec.name, 'done via', host(url))
      return
    } catch (e) {
      const msg =
        e instanceof SlowMirror ? `${host(url)} 速度过慢，切换镜像` : `${host(url)}: ${e instanceof Error ? e.message : String(e)}`
      log.warn('[download]', spec.name, msg)
      errors.push(msg)
    }
  }
  throw new Error(`下载失败：${errors.slice(-3).join('；')}`)
}
