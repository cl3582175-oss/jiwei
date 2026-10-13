import { app, BrowserWindow, session, utilityProcess } from 'electron'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readingHtmlText } from '../../src/main/lib/reading'
import { segmentText } from '../../src/main/lib/segment'
import * as local from '../../src/main/services/ai/localEmbedding'
import { LOCAL_EMBEDDING } from '../../src/shared/ai'
import { P0_PARAGRAPHS } from './retrievalP0'

/** 探针先证明现有库的行为；P3 的生产实现按 P0 结论独立开发并测试。 */
function extract(html: string): { text: string; flat: string; paragraphs: number; title: string } {
  const { document } = parseHTML(html)
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? document.title
  document
    .querySelectorAll(
      'script,style,noscript,template,svg,iframe,canvas,form,nav,footer,aside,[hidden],[aria-hidden="true"],[data-jiwei-ui]'
    )
    .forEach((e) => e.remove())
  document.querySelectorAll('[style]').forEach((e) => {
    if (/(display:none|visibility:hidden|font-size:0(?:px|em|rem|pt|%|;|$))/i.test((e.getAttribute('style') ?? '').replace(/\s/g, '')))
      e.remove()
  })
  const article = new Readability(document as unknown as Document).parse()
  const content = article?.content ?? document.body.innerHTML
  const flat = readingHtmlText(content)
  const cleaned = parseHTML(content).document
  // 现有 helper 压平段落；逐个读取叶子块复用其可见文字规则。
  const blocks = [...cleaned.querySelectorAll('p,li,h1,h2,h3,blockquote,pre')].filter(
    (n) => !n.querySelector('p,li,h1,h2,h3,blockquote,pre')
  )
  const text = (
    blocks.length
      ? blocks
          .map((n) => readingHtmlText(n.outerHTML))
          .filter(Boolean)
          .join('\n\n')
      : flat
  ).replace(/[\u200b-\u200d\ufeff\u2060]/g, '')
  return { title, text, flat, paragraphs: segmentText(text, 'plain').length }
}

export async function probePages(base: string): Promise<unknown> {
  const s = session.fromPartition('jiwei-p0-reader')
  await s.setProxy({ mode: 'system' })
  s.setPermissionRequestHandler((_w, _p, callback) => callback(false))
  s.on('will-download', (e) => e.preventDefault())
  s.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: ['image', 'media', 'font'].includes(details.resourceType) || !/^https?:/.test(details.url) })
  )
  const results: Record<string, unknown> = {}
  for (const path of ['/article', '/list', '/js', '/hidden']) {
    const direct = await fetch(base + path).then((r) => r.text())
    const w = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        images: false,
        session: s
      }
    })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await w.loadURL(base + path)
      await new Promise((r) => setTimeout(r, 1500))
      const rendered = (await w.webContents.executeJavaScript('document.documentElement.outerHTML', true)) as string
      results[path] = { direct: extract(direct), rendered: extract(rendered) }
    } finally {
      w.destroy()
      await s.clearStorageData()
    }
  }
  results.windowsAfter = BrowserWindow.getAllWindows().filter((w) => w.webContents.session === s).length
  return results
}

export async function probePdf(path: string): Promise<{ text: string; segments: number }> {
  const worker = utilityProcess.fork(join(app.getAppPath(), 'out/main/worker.js'))
  try {
    const result = await new Promise<{ segments: { text: string }[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('P0 PDF worker timed out')), 20_000)
      worker.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('P0 PDF worker exited'))
      })
      worker.on('message', (m) => {
        if (m.id === 'p0-pdf' && 'ok' in m) {
          clearTimeout(timer)
          if (m.ok) resolve(m.result)
          else reject(new Error('P0 PDF parsing failed'))
        }
      })
      worker.postMessage({ id: 'p0-pdf', task: 'parsePdf', payload: { path } })
    })
    return { text: result.segments.map((s) => s.text).join('\n\n'), segments: result.segments.length }
  } finally {
    worker.kill()
  }
}

export async function probeEmbedding(): Promise<{ count: number; ms: number; warmMs: number; dim: number }> {
  const old = join(app.getPath('appData'), 'jiwei-models')
  const isolated = join(app.getPath('userData'), 'model-appdata')
  mkdirSync(isolated, { recursive: true })
  const dest = join(isolated, 'jiwei-models')
  mkdirSync(dest, { recursive: true })
  // 只复制只读模型及运行时，不复制 PID，不影响正在使用的本地服务。
  for (const name of ['embeddinggemma-2-Q8_0.gguf', 'llama-b11491'])
    if (existsSync(join(old, name))) cpSync(join(old, name), join(dest, name), { recursive: true })
  app.setPath('appData', isolated)
  try {
    if (!(await local.isInstalled())) await local.install(() => {})
    const begin = performance.now()
    await local.start()
    const warmMs = Math.round(performance.now() - begin)
    const start = performance.now()
    const vectors: number[][] = []
    for (let i = 0; i < P0_PARAGRAPHS.length; i += 16)
      vectors.push(...(await local.embedRaw(P0_PARAGRAPHS.slice(i, i + 16).map((t) => LOCAL_EMBEDDING.docPrefix('P0 evidence') + t))))
    return { count: vectors.length, dim: vectors[0].length, ms: Math.round(performance.now() - start), warmMs }
  } finally {
    local.stop()
  }
}
