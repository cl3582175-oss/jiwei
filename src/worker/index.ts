import { readFile } from 'fs/promises'
import { expandICS } from '../main/lib/ics'
import { segmentText, type TextSegment } from '../main/lib/segment'
import { parseDocx, parseEpub, parseHtml, parsePdf, renderPdfPage } from './parsers'
import { transcribe } from './transcribe'
import { extractVoiceprints, type VoiceprintInput } from './voiceprint'
import { synthesizeLocal, type SpeechInput } from './speech'
import { scanLibrary, type ImportHistory } from '../main/services/importer/scan'
import { importMarkdown } from '../main/lib/importMarkdown'

// 后台工作进程（Electron utilityProcess）：执行 CPU / IO 密集任务，不阻塞主进程与界面。
// 协议：{ id, task, payload } 启动，{ cancel: id } 取消单项；只在任务实际退出后回复终态。

type Task = (payload: unknown, progress: (p: number) => void, signal: AbortSignal) => Promise<unknown>

const tasks: Record<string, Task> = {
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
    return segmentText(raw, ext === 'md' || ext === 'markdown' ? 'markdown' : 'plain') satisfies TextSegment[]
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
  'import.scan': (payload, progress, signal) => {
    const input = payload as { paths: string[]; history: ImportHistory[] }
    return scanLibrary(input.paths, input.history, progress, signal)
  },
  async 'import.convert'(payload) {
    const input = payload as { text: string; filename: string }
    return importMarkdown(input.text, input.filename)
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
