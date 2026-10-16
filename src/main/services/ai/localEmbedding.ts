import { stat } from 'fs/promises'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import log from 'electron-log/main'
import { download, type DownloadProgress } from '../download'
import { modelsDir } from './accel'
import { LlamaServer } from './llamaServer'
import { runEmbeddingBenchmark } from './llamaBenchmark'
import { getSettings } from '../settings'
export { freePort } from './llamaServer'
import { ensureRuntime, llamaSupported, runtimeDownloadSize, runtimeManager, serverBinary } from './llamaRuntime'
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

export async function downloadSize(): Promise<number> {
  const modelBytes = await stat(modelPath()).then(
    (s) => (s.size === MODEL.size ? 0 : MODEL.size),
    () => MODEL.size
  )
  return modelBytes + (llamaSupported() ? await runtimeDownloadSize() : 0)
}

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

const serverArgs = (): string[] => [
  '-m',
  modelPath(),
  '--embedding',
  // -c 是四个槽的总预算；HTML 表格在 1800 字内仍可能超过原来每槽 2048 词元。
  '-c',
  '32768',
  '-b',
  '8192',
  '-ub',
  '8192',
  '-np',
  '4'
]
const server = new LlamaServer({
  service: 'embedding',
  args: serverArgs,
  healthTimeoutMs: 30_000,
  beforeSpawn: killOrphan,
  onSpawn: (child) => {
    if (child.pid) writeFileSync(pidFile(), String(child.pid))
  },
  onExit: () => rmSync(pidFile(), { force: true })
})

export const start = (): Promise<void> => server.start()
export function stop(): void {
  void server.stop().catch((error) => log.warn('[embedding] stop failed', error))
}
export const isRunning = (): boolean => server.isRunning()

/** Fixed synthetic health check; OCR-only installs do not implicitly download an embedding model. */
export async function prepareLocalCompute(): Promise<void> {
  if (!['win32', 'linux'].includes(process.platform) || getSettings().ai.localCompute === 'cpu' || !(await isInstalled())) return
  const runtime = await runtimeManager.ensure()
  if (runtime.variant === 'cpu') return
  await runEmbeddingBenchmark(runtime.variant, (computeMode) => {
    const probe = new LlamaServer({
      service: 'embedding',
      args: serverArgs,
      healthTimeoutMs: 30_000,
      computeMode,
      recover: false,
      publishStatus: false
    })
    return {
      start: () => probe.start(),
      layers: () => probe.snapshot().offloadedLayers,
      embed: (inputs) => probe.run((url) => requestEmbedding(url, inputs)),
      dispose: () => probe.dispose()
    }
  })
}

/** 计算向量（原始 768 维，由调用方截断与归一化） */
export async function embedRaw(inputs: string[]): Promise<number[][]> {
  await prepareLocalCompute()
  return server.run((url) => requestEmbedding(url, inputs))
}

async function requestEmbedding(url: string, inputs: string[]): Promise<number[][]> {
  const res = await fetch(`${url}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: inputs })
  })
  if (!res.ok) throw new Error(`本地向量模型出错：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { data: { index: number; embedding: number[] }[] }
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}
