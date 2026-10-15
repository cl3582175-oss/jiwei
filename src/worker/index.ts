import { parseXlsx } from '../main/services/parsers/xlsx'
import { parseCsv } from '../main/services/parsers/csv'
import { parsePptx } from '../main/services/parsers/pptx'
import { parseCode } from '../main/services/parsers/code'
import { readFile } from 'fs/promises'
import { expandICS } from '../main/lib/ics'
import { segmentTextStructured } from '../main/lib/segment'
import {
  parseEpubStructured as parseEpub,
  parseHtmlStructured as parseHtml,
  parsePdfStructured as parsePdf,
  renderPdfPage
} from './parsers'
import { parseDocx } from './docx'
import { parseDoc } from './doc'
import { transcribe } from './transcribe'
import { extractVoiceprints, type VoiceprintInput } from './voiceprint'
import { synthesizeLocal, type SpeechInput } from './speech'
import { scanLibrary, type ImportHistory } from '../main/services/importer/scan'
import { importMarkdown } from '../main/lib/importMarkdown'
import { convertNotion } from '../main/services/importer/notion'
import { extractSafeZip } from '../main/services/importer/zip'
import { mkdir, realpath, rm, lstat } from 'fs/promises'
import { basename, dirname, extname } from 'path'
import { createHash } from 'crypto'

// 后台工作进程（Electron utilityProcess）：执行 CPU / IO 密集任务，不阻塞主进程与界面。
// 协议：{ id, task, payload } 启动，{ cancel: id } 取消单项；只在任务实际退出后回复终态。

type Task = (payload: unknown, progress: (p: number) => void, signal: AbortSignal) => Promise<unknown>

const tasks: Record<string, Task> = {
  async parseXlsx(payload) {
    return parseXlsx((payload as { path: string }).path)
  },
  async parseCsv(payload) {
    const { path, name } = payload as { path: string; name?: string }
    return parseCsv(path, name)
  },
  async parsePptx(payload) {
    return parsePptx((payload as { path: string }).path)
  },
  async parseCode(payload) {
    const { path, ext } = payload as { path: string; ext: string }
    return parseCode(path, ext)
  },
  async parseICS(payload) {
    const { body, range } = payload as { body: string; range: { startAt: number; endAt: number } }
    return expandICS(body, range)
  },
  voiceprint: (payload, progress, signal) => extractVoiceprints(payload as VoiceprintInput, progress, signal),
  /** 本机语音合成（每日播客） */
  speech: (payload, progress, signal) => synthesizeLocal(payload as SpeechInput, progress, signal),
  /** 读取文本类文件并分段 */
  async segmentTextFile(payload) {
    const { path, ext } = payload as { path: string; ext: string }
    const raw = await readFile(path, 'utf8')
    return segmentTextStructured(raw, ext === 'md' || ext === 'markdown' ? 'markdown' : 'plain')
  },
  async parsePdf(payload, progress) {
    return parsePdf((payload as { path: string }).path, progress)
  },
  /** PDF 的一页绘制成 JPEG（文档识别） */
  async renderPdfPage(payload) {
    const { path, page, maxSide } = payload as { path: string; page: number; maxSide?: number }
    return renderPdfPage(path, page, maxSide)
  },
  async parseDocx(payload) {
    return parseDocx((payload as { path: string }).path)
  },
  async parseDoc(payload) {
    return parseDoc((payload as { path: string }).path)
  },
  async parseEpub(payload, progress) {
    return parseEpub((payload as { path: string }).path, progress)
  },
  async parseHtml(payload) {
    return parseHtml((payload as { path: string }).path)
  },
  /** 视频 / 音频转写 */
  async transcribe(payload, progress) {
    return transcribe(payload as Parameters<typeof transcribe>[0], progress)
  },
  /** 测试用：休眠指定毫秒并汇报进度 */
  async sleep(payload, progress) {
    const { ms } = payload as { ms: number }
    for (let i = 1; i <= 4; i++) {
      await new Promise((r) => setTimeout(r, ms / 4))
      progress(i / 4)
    }
    return { slept: ms }
  },
  async 'import.scan'(payload, progress, signal) {
    const input = payload as { paths: string[]; history: ImportHistory[]; format?: 'notion'; destination: string }
    if (input.format === 'notion') {
      if ((await lstat(input.paths[0])).isSymbolicLink()) throw new Error('zip-link')
      const original = await realpath(input.paths[0]),
        rootHash = createHash('sha256').update(original).digest('hex')
      if (extname(original).toLowerCase() === '.zip') {
        await mkdir(dirname(input.destination), { recursive: true, mode: 0o700 })
        await rm(input.destination, { recursive: true, force: true })
        const skipped = await extractSafeZip(original, input.destination, signal, (p) => progress(p * 0.4))
        const library = await scanLibrary([input.destination], input.history, (p) => progress(0.4 + 0.6 * p), signal, {
          kind: 'notion',
          rootHash,
          label: basename(original, extname(original))
        })
        library.issues.push(...skipped.map((path) => ({ path, code: 'too-large' as const })))
        return library
      }
      return scanLibrary(input.paths, input.history, progress, signal, { kind: 'notion', rootHash })
    }
    return scanLibrary(input.paths, input.history, progress, signal)
  },
  async 'import.convert'(payload) {
    const input = payload as { text: string; filename: string; kind?: string; pages?: string[] }
    return input.kind === 'notion'
      ? convertNotion(input.text, input.filename, input.pages ?? [])
      : importMarkdown(input.text, input.filename)
  }
}

const active = new Map<string, AbortController>()
process.parentPort.on('message', (e) => {
  if (typeof e.data.cancel === 'string') {
    active.get(e.data.cancel)?.abort()
    return
  }
  const { id, task, payload } = e.data as { id: string; task: string; payload: unknown }
  const fn = tasks[task]
  if (!fn) {
    process.parentPort.postMessage({ id, ok: false, error: `Unknown task: ${task}` })
    return
  }
  const abort = new AbortController()
  active.set(id, abort)
  fn(
    payload,
    (p) => {
      if (!abort.signal.aborted) process.parentPort.postMessage({ id, progress: p })
    },
    abort.signal
  )
    .then((result) => {
      abort.signal.throwIfAborted()
      process.parentPort.postMessage({ id, ok: true, result })
    })
    .catch((err: unknown) => process.parentPort.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => active.delete(id))
})
