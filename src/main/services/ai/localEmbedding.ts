import { spawn, type ChildProcess } from 'child_process'
import { stat } from 'fs/promises'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import log from 'electron-log/main'
import { download, type DownloadProgress } from '../download'
import { modelsDir } from './accel'
import { ensureRuntime, llamaSupported, serverBinary } from './llamaRuntime'
export { modelsDir } from './accel'
export { ensureRuntime, llamaSupported, runtimeDownloadSize, serverBinary } from './llamaRuntime'

// 内置向量模型：EmbeddingGemma 2（Google DeepMind，Apache 2.0）由 llama.cpp 的 llama-server 在本机运行。
// 模型与运行时都在首次使用时下载到所有知识库共享的目录，并校验 sha256。

const MODEL = {
  file: 'embeddinggemma-2-Q8_0.gguf',
  size: 309855456,
  sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
  urls: [
    'https://www.modelscope.cn/models/ggml-org/embeddinggemma-2-GGUF/resolve/master/embeddinggemma-2-Q8_0.gguf',
    'https://hf-mirror.com/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-Q8_0.gguf',
    'https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-Q8_0.gguf'
  ]
}

const modelPath = (): string => join(modelsDir(), MODEL.file)

export async function isInstalled(): Promise<boolean> {
  const [bin, model] = await Promise.all([
    serverBinary(),
    stat(modelPath()).then(
      (s) => s.size === MODEL.size,
      () => false
    )
  ])
  return !!bin && model
}

/** 下载并安装运行时与模型（已存在且校验通过则跳过） */
export async function install(onProgress: (p: DownloadProgress & { stage: 'runtime' | 'model' }) => void): Promise<void> {
  if (!llamaSupported()) throw new Error(`暂不支持此平台的本地向量模型：${process.platform}-${process.arch}，请在设置中改用云端向量服务`)
  let runtimeBytes = 0
  await ensureRuntime((p) => {
    runtimeBytes = p.total
    onProgress({ ...p, total: runtimeBytes + MODEL.size, stage: 'runtime' })
  })
  await download({ name: 'EmbeddingGemma 2', size: MODEL.size, sha256: MODEL.sha256, urls: MODEL.urls, dest: modelPath() }, (p) =>
    onProgress({ ...p, received: runtimeBytes + p.received, total: runtimeBytes + p.total, stage: 'model' })
  )
}

/* ——— 本地服务进程 ——— */

let proc: ChildProcess | null = null
let port = 0
let starting: Promise<void> | null = null

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port
      srv.close(() => resolve(p))
    })
    srv.on('error', reject)
  })
}

/** 记录服务进程 PID：上次异常退出遗留的进程在下次启动时清理 */
const pidFile = (): string => join(modelsDir(), 'llama-server.pid')

function killOrphan(): void {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    if (pid > 0) process.kill(pid)
    log.info('[embedding] killed orphan llama-server', pid)
  } catch {
    /* 没有遗留进程 */
  }
  rmSync(pidFile(), { force: true })
}

export async function start(): Promise<void> {
  if (proc && port) return
  if (starting) return starting
  starting = (async () => {
    const bin = await serverBinary()
    if (!bin) throw new Error('本地向量模型尚未安装')
    killOrphan()
    port = await freePort()
    const args = [
      '-m',
      modelPath(),
      '--embedding',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-c',
      // -c 是四个槽的总预算；HTML 表格在1800字内仍可能超过原来每槽2048词元。
      '32768',
      '-b',
      '8192',
      '-ub',
      '8192',
      '-np',
      '4'
    ]
    log.info('[embedding] starting llama-server on', port)
    proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    if (proc.pid) writeFileSync(pidFile(), String(proc.pid))
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
    proc.on('exit', (code) => {
      log.warn('[embedding] llama-server exited', code, stderr.slice(-500))
      proc = null
      port = 0
    })
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (!proc) throw new Error(`本地向量模型启动失败：${stderr.slice(-300)}`)
      const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
        (r) => r.ok,
        () => false
      )
      if (ok) return
    }
    stop()
    throw new Error('本地向量模型启动超时')
  })().finally(() => {
    starting = null
  })
  return starting
}

export function stop(): void {
  proc?.kill()
  rmSync(pidFile(), { force: true })
  proc = null
  port = 0
}

export function isRunning(): boolean {
  return !!proc && !!port
}

/** 计算向量（原始 768 维，由调用方截断与归一化） */
export async function embedRaw(inputs: string[]): Promise<number[][]> {
  await start()
  const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: inputs })
  })
  if (!res.ok) throw new Error(`本地向量模型出错：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { data: { index: number; embedding: number[] }[] }
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

// 主进程无论以何种方式退出，都结束本地服务进程
process.on('exit', () => proc?.kill())
