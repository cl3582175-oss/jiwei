import { readFile } from 'fs/promises'
import { segmentText, type TextSegment } from '../main/lib/segment'
import { parseDocx, parseEpub, parseHtml, parsePdf } from './parsers'
import { transcribe } from './transcribe'

// 后台工作进程（Electron utilityProcess）：执行 CPU / IO 密集任务，不阻塞主进程与界面。
// 协议：主进程发送 { id, task, payload }；本进程回复 { id, progress } 或 { id, ok, result | error }。

type Task = (payload: unknown, progress: (p: number) => void) => Promise<unknown>

const tasks: Record<string, Task> = {
  /** 读取文本类文件并分段 */
  async segmentTextFile(payload) {
    const { path, ext } = payload as { path: string; ext: string }
    const raw = await readFile(path, 'utf8')
    return segmentText(raw, ext === 'md' || ext === 'markdown' ? 'markdown' : 'plain') satisfies TextSegment[]
  },
  async parsePdf(payload, progress) {
    return parsePdf((payload as { path: string }).path, progress)
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
  }
}

process.parentPort.on('message', (e) => {
  const { id, task, payload } = e.data as { id: string; task: string; payload: unknown }
  const fn = tasks[task]
  if (!fn) {
    process.parentPort.postMessage({ id, ok: false, error: `Unknown task: ${task}` })
    return
  }
  fn(payload, (p) => process.parentPort.postMessage({ id, progress: p }))
    .then((result) => process.parentPort.postMessage({ id, ok: true, result }))
    .catch((err: unknown) => process.parentPort.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }))
})
