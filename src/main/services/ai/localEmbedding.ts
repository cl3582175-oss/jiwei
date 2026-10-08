import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { chmod, mkdir, readdir, rm, writeFile, stat } from 'fs/promises'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import log from 'electron-log/main'
import { x as untar } from 'tar'
import JSZip from 'jszip'
import { readFile } from 'fs/promises'
import { download, type DownloadProgress } from '../download'

// 内置向量模型：EmbeddingGemma 2（Google DeepMind，Apache 2.0）由 llama.cpp 的 llama-server 在本机运行。
// 模型与运行时都在首次使用时下载到所有知识库共享的目录，并校验 sha256。

const LLAMA_BUILD = 'b11491'
const GH = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}`
/** GitHub 在国内较慢：同时尝试加速镜像，按测速择优 */
const GH_MIRRORS = (path: string): string[] => [`https://gh-proxy.com/${GH}/${path}`, `https://ghfast.top/${GH}/${path}`, `${GH}/${path}`]

const RUNTIMES: Record<string, { file: string; size: number; sha256: string }> = {
  'darwin-arm64': {
    file: `llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`,
    size: 12041314,
    sha256: '5dc61b413298db5e5c547c39b40d1148844eca23f247f8741444837a7cc3626d'
  },
  'darwin-x64': {
    file: `llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz`,
    size: 11566950,
    sha256: '8ffd1d12c35f58216188365fc74e7f27a54e870aceaadb646174b93f149ce8b5'
  },
  'linux-x64': {
    file: `llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`,
    size: 17788991,
    sha256: '21af9f5d83e8598a7a426ee43be7e3af480c3f0ebadb8fd0c081569e8da04c21'
  },
  'win32-x64': {
    file: `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`,
    size: 19482775,
    sha256: 'dd73bb6652216f354a8786970cc50f6d90768cde2a6c47321976f7bd5b02447b'
  }
}

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

/** 所有知识库共享的模型目录（模型很大，不随知识库复制） */
export function modelsDir(): string {
  return join(app.getPath('appData'), 'jiwei-models')
}

const runtimeDir = (): string => join(modelsDir(), `llama-${LLAMA_BUILD}`)
const modelPath = (): string => join(modelsDir(), MODEL.file)

async function findFile(dir: string, name: string): Promise<string | null> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isFile() && e.name === name) return p
    if (e.isDirectory()) {
      const f = await findFile(p, name)
      if (f) return f
    }
  }
  return null
}

async function serverBinary(): Promise<string | null> {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  return stat(runtimeDir()).then(
    () => findFile(runtimeDir(), name),
    () => null
  )
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
  const key = `${process.platform}-${process.arch}`
  const rt = RUNTIMES[key]
  if (!rt) throw new Error(`暂不支持此平台的本地向量模型：${key}，请在设置中改用云端向量服务`)
  if (!(await serverBinary())) {
    const archive = join(modelsDir(), rt.file)
    await download({ name: 'llama.cpp', size: rt.size, sha256: rt.sha256, urls: GH_MIRRORS(rt.file), dest: archive }, (p) =>
      onProgress({ ...p, stage: 'runtime' })
    )
    await rm(runtimeDir(), { recursive: true, force: true })
    await mkdir(runtimeDir(), { recursive: true })
    if (rt.file.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(await readFile(archive))
      for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue
        const out = join(runtimeDir(), name)
        await mkdir(join(out, '..'), { recursive: true })
        await writeFile(out, await entry.async('nodebuffer'))
      }
    } else {
      await untar({ file: archive, cwd: runtimeDir() })
    }
    await rm(archive, { force: true })
    const bin = await serverBinary()
    if (!bin) throw new Error('运行时解压后未找到 llama-server')
    if (process.platform !== 'win32') await chmod(bin, 0o755)
  }
  await download({ name: 'EmbeddingGemma 2', size: MODEL.size, sha256: MODEL.sha256, urls: MODEL.urls, dest: modelPath() }, (p) =>
    onProgress({ ...p, stage: 'model' })
  )
}

/* ——— 本地服务进程 ——— */

let proc: ChildProcess | null = null
let port = 0
let starting: Promise<void> | null = null

function freePort(): Promise<number> {
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
      '8192',
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
