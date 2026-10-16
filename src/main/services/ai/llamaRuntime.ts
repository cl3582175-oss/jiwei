import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, writeFileSync } from 'fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { promisify } from 'util'
import JSZip from 'jszip'
import { t as listTar, x as untar } from 'tar'
import type { GpuDevice, LocalComputeStatus, RuntimeVariant } from '@shared/localCompute'
import { download, type DownloadProgress, type DownloadSpec } from '../download'
import { getSettings } from '../settings'
import {
  chooseVariant,
  cudaRetryAllowed,
  detectNvidia,
  LLAMA_BUILD,
  loadAccel,
  modelsDir,
  notifyComputeChanged,
  parseDevices,
  recordCudaDownloadFailure,
  retryCudaDownloads,
  setCudaDisabled,
  updateAccel,
  type NvidiaDevice
} from './accel'

export interface RuntimeArchive {
  file: string
  size: number
  sha256: string
}
export interface RuntimeSpec {
  variant: RuntimeVariant
  archives: RuntimeArchive[]
}
export interface RuntimeInstallation {
  binary: string
  directory: string
  variant: RuntimeVariant
  legacy: boolean
}

const archive = (file: string, size: number, sha256: string): RuntimeArchive => ({ file, size, sha256 })
const ASSETS = {
  macArm: archive(
    `llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`,
    12041314,
    '5dc61b413298db5e5c547c39b40d1148844eca23f247f8741444837a7cc3626d'
  ),
  macIntel: archive(
    `llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz`,
    11566950,
    '8ffd1d12c35f58216188365fc74e7f27a54e870aceaadb646174b93f149ce8b5'
  ),
  linuxCpu: archive(
    `llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`,
    17788991,
    '21af9f5d83e8598a7a426ee43be7e3af480c3f0ebadb8fd0c081569e8da04c21'
  ),
  linuxVulkan: archive(
    `llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-x64.tar.gz`,
    31736217,
    'cb91f3ee4935b68ebf95554a228440efb9dc5fbeb62af7e5076e10b6d28e715b'
  ),
  winCpu: archive(`llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`, 19482775, 'dd73bb6652216f354a8786970cc50f6d90768cde2a6c47321976f7bd5b02447b'),
  winVulkan: archive(
    `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`,
    33423649,
    'ebcee6f140ca8e6145af62f48007e99344ae08dbd97786b2f697483c4a5e3729'
  ),
  cuda13: archive(
    `llama-${LLAMA_BUILD}-bin-win-cuda-13.4-x64.zip`,
    153309047,
    '82f52784db12499418150837829ff0f8b6e4307db4410217fc6de891a1c4bd27'
  ),
  cuda13rt: archive(
    'cudart-llama-bin-win-cuda-13.4-x64.zip',
    423535356,
    '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668'
  ),
  cuda12: archive(
    `llama-${LLAMA_BUILD}-bin-win-cuda-12.4-x64.zip`,
    264959976,
    '128126e0fd59ea93c96dee2a9748df08c20b9f55a52d7a7a470a9b83276b6de7'
  ),
  cuda12rt: archive('cudart-llama-bin-win-cuda-12.4-x64.zip', 391443627, '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6')
}

export function runtimeSpec(
  variant: RuntimeVariant,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): RuntimeSpec {
  if (platform === 'darwin' && ((arch === 'arm64' && (variant === 'metal' || variant === 'cpu')) || (arch === 'x64' && variant === 'cpu')))
    return { variant, archives: [arch === 'arm64' ? ASSETS.macArm : ASSETS.macIntel] }
  if (platform === 'linux' && arch === 'x64' && (variant === 'cpu' || variant === 'vulkan'))
    return { variant, archives: [variant === 'cpu' ? ASSETS.linuxCpu : ASSETS.linuxVulkan] }
  if (platform === 'win32' && arch === 'x64') {
    const files = {
      cpu: [ASSETS.winCpu],
      vulkan: [ASSETS.winVulkan],
      cuda12: [ASSETS.cuda12, ASSETS.cuda12rt],
      cuda13: [ASSETS.cuda13, ASSETS.cuda13rt]
    }
    if (variant !== 'metal') return { variant, archives: files[variant] }
  }
  throw new Error(`不支持本地模型运行时：${platform}-${arch}/${variant}`)
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return false
      throw e
    }
  )

async function findBinary(directory: string, name: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const found = await findBinary(path, name)
      if (found) return found
    }
  }
  return null
}

function safePath(directory: string, name: string): string {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..'))
    throw new Error('运行时压缩包包含不安全路径')
  const path = resolve(directory, normalized)
  if (relative(directory, path).startsWith('..') || isAbsolute(relative(directory, path))) throw new Error('运行时压缩包路径越界')
  return path
}

async function extract(archivePath: string, staging: string): Promise<void> {
  if (archivePath.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(await readFile(archivePath))
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue
      const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name
      safePath(staging, original)
      const output = safePath(staging, entry.name)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, await entry.async('nodebuffer'))
    }
  } else {
    let unsafe: Error | null = null
    await listTar({
      file: archivePath,
      preservePaths: true,
      strict: true,
      onReadEntry: (entry) => {
        try {
          const output = safePath(staging, entry.path)
          if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
            if (!entry.linkpath) throw new Error('运行时压缩包链接路径无效')
            const base = entry.type === 'SymbolicLink' ? dirname(output) : staging
            const target = resolve(base, entry.linkpath)
            safePath(staging, relative(staging, target))
          }
        } catch (error) {
          unsafe = error instanceof Error ? error : new Error('运行时压缩包路径无效')
        }
      }
    })
    if (unsafe) throw unsafe
    await untar({ file: archivePath, cwd: staging, strict: true })
  }
}

async function verify(path: string, archive: RuntimeArchive): Promise<void> {
  if ((await stat(path)).size !== archive.size) throw new Error(`${archive.file} 文件大小不符`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== archive.sha256) throw new Error(`${archive.file} 校验失败（sha256）`)
}

async function probe(binary: string): Promise<GpuDevice[]> {
  const result = await promisify(execFile)(binary, ['--list-devices'], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8'
  })
  return parseDevices(`${result.stdout}\n${result.stderr}`)
}

interface Environment {
  platform: NodeJS.Platform
  arch: string
  directory: () => string
  detect: () => Promise<NvidiaDevice[]>
  mode: () => 'auto' | 'cpu'
}
interface RuntimeIo {
  download: (spec: DownloadSpec, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal) => Promise<void>
  probe: (binary: string) => Promise<GpuDevice[]>
}

/** One owner for installation, upgrades and leases shared by embedding and OCR. */
export class LlamaRuntimeManager {
  private reclaiming: Promise<void> | null = null
  private installedListeners = new Set<(runtime: RuntimeInstallation) => void>()
  private installing = new Map<RuntimeVariant, Promise<RuntimeInstallation>>()
  private progressListeners = new Map<RuntimeVariant, Set<(p: DownloadProgress) => void>>()
  private controllers = new Map<RuntimeVariant, AbortController>()
  private nvidia: Promise<NvidiaDevice[]> | null = null
  private attemptedCuda = false
  private upgrading: Promise<RuntimeInstallation | null> | null = null
  private upgraded = new Set<RuntimeVariant>()
  private leases = new Map<string, number>()
  private healthy: RuntimeInstallation | null = null
  private cleaning: Promise<void> = Promise.resolve()
  private state: LocalComputeStatus['runtime'] = {
    variant: null,
    downloading: false,
    receivedBytes: 0,
    totalBytes: 0,
    speed: null,
    mirror: null,
    error: null
  }

  constructor(
    private environment: Environment = {
      platform: process.platform,
      arch: process.arch,
      directory: modelsDir,
      detect: () => detectNvidia(),
      mode: () => getSettings().ai.localCompute ?? 'auto'
    },
    private io: RuntimeIo = { download, probe },
    private manifest: (variant: RuntimeVariant) => RuntimeSpec = (variant) => runtimeSpec(variant, environment.platform, environment.arch)
  ) {}

  private directory(variant: RuntimeVariant): string {
    return join(this.environment.directory(), `llama-${LLAMA_BUILD}-${variant}`)
  }
  private binaryName(): string {
    return this.environment.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  }
  /** PID ownership protects live installers across app instances; old UUID-only remnants are also recognized. */
  private reclaimAbandoned(): Promise<void> {
    if (this.reclaiming) return this.reclaiming
    const work = (async () => {
      const root = this.environment.directory()
      const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
      const pattern = new RegExp(`^llama-${LLAMA_BUILD}-(metal|cpu|vulkan|cuda12|cuda13)\\.(install|previous)-(?:(\\d+)-)?${uuid}$`, 'i')
      const alive = (pid: string | undefined): boolean => {
        if (!pid) return false
        try {
          process.kill(Number(pid), 0)
          return true
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ESRCH'
        }
      }
      const candidates = entries
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const match = pattern.exec(entry.name)
          return match ? [{ path: join(root, entry.name), variant: match[1] as RuntimeVariant, kind: match[2], live: alive(match[3]) }] : []
        })
      const liveVariants = new Set(candidates.filter((entry) => entry.live).map((entry) => entry.variant))
      for (const entry of candidates) {
        if (entry.live || liveVariants.has(entry.variant)) continue
        try {
          if (await this.inUse(entry.path)) continue
          if (entry.kind === 'install') await rm(entry.path, { recursive: true, force: true })
          else if (!(await exists(this.directory(entry.variant)))) await rename(entry.path, this.directory(entry.variant))
          else if (await this.installed(entry.variant)) await rm(entry.path, { recursive: true, force: true })
        } catch (error) {
          // Another app may have reclaimed this same dead owner's directory first.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    })().finally(() => {
      this.reclaiming = null
    })
    this.reclaiming = work
    return work
  }
  snapshot(): LocalComputeStatus['runtime'] {
    return { ...this.state }
  }
  onInstalled(listener: (runtime: RuntimeInstallation) => void): () => void {
    this.installedListeners.add(listener)
    return () => {
      this.installedListeners.delete(listener)
    }
  }

  async desired(): Promise<RuntimeVariant> {
    if (this.environment.mode() === 'cpu')
      return this.environment.platform === 'darwin' && this.environment.arch === 'arm64' ? 'metal' : 'cpu'
    this.nvidia ??= this.environment.detect()
    return chooseVariant(this.environment.platform, this.environment.arch, await this.nvidia, !cudaRetryAllowed() || this.attemptedCuda)
  }

  async nvidiaDevices(): Promise<NvidiaDevice[]> {
    this.nvidia ??= this.environment.detect()
    return this.nvidia
  }
  async cudaOption(): Promise<RuntimeSpec | null> {
    if (this.environment.platform !== 'win32' || this.environment.arch !== 'x64') return null
    const variant = chooseVariant(this.environment.platform, this.environment.arch, await this.nvidiaDevices())
    return variant.startsWith('cuda') ? this.manifest(variant) : null
  }
  async discover(): Promise<GpuDevice[]> {
    const runtime = await this.current()
    const devices = runtime ? await this.io.probe(runtime.binary) : []
    updateAccel((state) => {
      state.devices = devices
    })
    return devices
  }

  async installed(variant: RuntimeVariant): Promise<RuntimeInstallation | null> {
    const directory = this.directory(variant)
    if (!(await exists(directory))) return null
    try {
      const receipt = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
      if (
        receipt.build !== LLAMA_BUILD ||
        receipt.variant !== variant ||
        JSON.stringify(receipt.archives) !== JSON.stringify(this.manifest(variant).archives)
      )
        return null
      const binary = await findBinary(directory, this.binaryName())
      return binary ? { binary, directory, variant, legacy: false } : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES') throw error
      return null
    }
  }

  async current(): Promise<RuntimeInstallation | null> {
    await this.reclaimAbandoned()
    const active = loadAccel().activeVariant
    const variants: RuntimeVariant[] = [
      ...new Set<RuntimeVariant>([
        ...(active ? [active] : []),
        ...(this.environment.platform === 'darwin' ? (['metal', 'cpu'] as const) : (['vulkan', 'cuda13', 'cuda12', 'cpu'] as const))
      ])
    ]
    for (const variant of variants) {
      try {
        const found = await this.installed(variant)
        if (found) return found
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EACCES') throw error
      }
    }
    const directory = join(this.environment.directory(), `llama-${LLAMA_BUILD}`)
    if (!(await exists(directory))) return null
    const binary = await findBinary(directory, this.binaryName())
    return binary
      ? {
          binary,
          directory,
          variant: this.environment.platform === 'darwin' && this.environment.arch === 'arm64' ? 'metal' : 'cpu',
          legacy: true
        }
      : null
  }

  async downloadSize(): Promise<number> {
    const preferred = await this.desired()
    const existing = await this.current()
    if (
      (await this.installed(preferred)) ||
      (existing?.legacy && existing.variant === preferred) ||
      (this.environment.mode() === 'cpu' && existing)
    )
      return 0
    return this.manifest(preferred).archives.reduce((sum, a) => sum + a.size, 0)
  }

  async ensure(onProgress: (p: DownloadProgress) => void = () => undefined): Promise<RuntimeInstallation> {
    await this.reclaimAbandoned()
    const preferred = await this.desired()
    const ready = await this.installed(preferred)
    if (ready) return ready
    const existing = await this.current()
    if (existing) {
      if (this.environment.mode() === 'cpu' || existing.variant === preferred) return existing
      if (!this.upgrading && !this.upgraded.has(preferred)) {
        this.upgraded.add(preferred)
        this.upgrading = this.installPreferred(preferred)
          .catch((error: unknown) => {
            this.state.error = error instanceof Error ? error.message : String(error)
            notifyComputeChanged()
            return null
          })
          .finally(() => {
            this.upgrading = null
          })
      }
      return existing
    }
    return this.installPreferred(preferred, onProgress)
  }

  waitForUpgrade(): Promise<RuntimeInstallation | null> {
    return this.upgrading ?? Promise.resolve(null)
  }

  private async installPreferred(
    preferred: RuntimeVariant,
    onProgress: (p: DownloadProgress) => void = () => undefined
  ): Promise<RuntimeInstallation> {
    try {
      const result = await this.install(this.manifest(preferred), onProgress)
      if (preferred.startsWith('cuda'))
        updateAccel((s) => {
          s.cuda.failures = 0
          s.cuda.reason = null
        })
      return result
    } catch (error) {
      if (!preferred.startsWith('cuda')) throw error
      if (loadAccel().cuda.disabled) throw error
      // Both services and repeated requests share this startup-scoped attempt.
      if (!this.attemptedCuda) {
        this.attemptedCuda = true
        recordCudaDownloadFailure(error instanceof Error ? error.message : String(error))
      }
      try {
        return await this.install(this.manifest('vulkan'), onProgress)
      } catch (fallbackError) {
        throw new AggregateError(
          [error, fallbackError],
          `CUDA: ${error instanceof Error ? error.message : String(error)}；Vulkan: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          { cause: fallbackError }
        )
      }
    }
  }

  async install(spec: RuntimeSpec, onProgress: (p: DownloadProgress) => void = () => undefined): Promise<RuntimeInstallation> {
    await this.reclaimAbandoned()
    const ready = await this.installed(spec.variant)
    if (ready) return ready
    const listeners = this.progressListeners.get(spec.variant) ?? new Set<(p: DownloadProgress) => void>()
    listeners.add(onProgress)
    this.progressListeners.set(spec.variant, listeners)
    try {
      let pending = this.installing.get(spec.variant)
      if (!pending) {
        pending = this.extractRuntime(spec).finally(() => {
          this.installing.delete(spec.variant)
          this.progressListeners.delete(spec.variant)
          this.controllers.delete(spec.variant)
        })
        this.installing.set(spec.variant, pending)
      }
      return await pending
    } finally {
      listeners.delete(onProgress)
    }
  }

  private async extractRuntime(spec: RuntimeSpec): Promise<RuntimeInstallation> {
    const root = this.environment.directory(),
      target = this.directory(spec.variant)
    const staging = `${target}.install-${process.pid}-${randomUUID()}`
    const controller = new AbortController()
    this.controllers.set(spec.variant, controller)
    await mkdir(staging, { recursive: true })
    let completed = 0
    const total = spec.archives.reduce((sum, a) => sum + a.size, 0)
    this.state = { ...this.state, downloading: true, totalBytes: total, receivedBytes: 0, speed: null, mirror: null, error: null }
    notifyComputeChanged()
    try {
      for (const asset of spec.archives) {
        controller.signal.throwIfAborted()
        const path = join(root, '.llama-downloads', asset.file)
        const base = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${asset.file}`
        await this.io.download(
          {
            name: asset.file,
            dest: path,
            size: asset.size,
            sha256: asset.sha256,
            urls: [`https://gh-proxy.com/${base}`, `https://ghfast.top/${base}`, base]
          },
          (p) => {
            const progress = { ...p, received: Math.min(total, completed + p.received), total }
            this.state = { ...this.state, receivedBytes: progress.received, speed: p.speed, mirror: p.mirror }
            for (const listener of this.progressListeners.get(spec.variant) ?? []) listener(progress)
            notifyComputeChanged()
          },
          controller.signal
        )
        await verify(path, asset)
        await extract(path, staging)
        completed += asset.size
      }
      controller.signal.throwIfAborted()
      const binary = await findBinary(staging, this.binaryName())
      if (!binary) throw new Error('运行时解压后未找到 llama-server')
      if (this.environment.platform !== 'win32') await chmod(binary, 0o755)
      const devices = await this.io.probe(binary)
      controller.signal.throwIfAborted()
      await writeFile(join(staging, 'runtime.json'), JSON.stringify({ build: LLAMA_BUILD, variant: spec.variant, archives: spec.archives }))
      let previous: string | null = null
      if (await exists(target)) {
        if (await this.inUse(target)) throw new Error('旧运行时仍在使用，稍后重试安装')
        previous = `${target}.previous-${process.pid}-${randomUUID()}`
        await rename(target, previous)
      }
      try {
        await rename(staging, target)
      } catch (error) {
        if (previous) await rename(previous, target)
        throw error
      }
      updateAccel((s) => {
        s.devices = devices
      })
      if (previous)
        await rm(previous, { recursive: true, force: true }).catch((error: unknown) => {
          this.state.error = `旧运行时目录清理未完成：${error instanceof Error ? error.message : String(error)}`
        })
      for (const asset of spec.archives) await rm(join(root, '.llama-downloads', asset.file), { force: true })
      this.state = { ...this.state, downloading: false, receivedBytes: total, variant: spec.variant, speed: null }
      notifyComputeChanged()
      const installed = { binary: join(target, relative(staging, binary)), directory: target, variant: spec.variant, legacy: false }
      for (const listener of this.installedListeners) {
        try {
          listener(installed)
        } catch {
          /* Installation is already committed; notification failure cannot undo it. */
        }
      }
      return installed
    } catch (error) {
      this.state = { ...this.state, downloading: false, error: error instanceof Error ? error.message : String(error), speed: null }
      notifyComputeChanged()
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  retain(runtime: RuntimeInstallation): void {
    const count = this.leases.get(runtime.directory) ?? 0
    this.leases.set(runtime.directory, count + 1)
    if (!count) writeFileSync(join(runtime.directory, `.lease-${process.pid}`), String(process.pid), { mode: 0o600 })
  }
  async release(runtime: RuntimeInstallation): Promise<void> {
    const remaining = Math.max(0, (this.leases.get(runtime.directory) ?? 0) - 1)
    if (remaining) this.leases.set(runtime.directory, remaining)
    else {
      this.leases.delete(runtime.directory)
      await rm(join(runtime.directory, `.lease-${process.pid}`), { force: true })
    }
    await this.cleanup()
  }
  private async inUse(directory: string): Promise<boolean> {
    if (this.leases.get(directory)) return true
    for (const name of await readdir(directory)) {
      const match = /^\.lease-(\d+)$/.exec(name)
      if (!match) continue
      try {
        process.kill(Number(match[1]), 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
      }
      await rm(join(directory, name), { force: true })
    }
    return false
  }
  async markHealthy(runtime: RuntimeInstallation): Promise<void> {
    this.healthy = runtime
    this.state.variant = runtime.variant
    updateAccel((state) => {
      state.activeVariant = runtime.variant
    })
    await this.cleanup()
  }
  private cleanup(): Promise<void> {
    this.cleaning = this.cleaning
      .catch(() => undefined)
      .then(async () => {
        if (this.healthy && !this.healthy.legacy) {
          const legacy = join(this.environment.directory(), `llama-${LLAMA_BUILD}`)
          if ((await exists(legacy)) && !(await this.inUse(legacy))) await rm(legacy, { recursive: true, force: true })
        }
        if (!loadAccel().cuda.removePending) return
        if (!(await this.installed('vulkan'))) return
        for (const directory of await this.cudaDirectories()) {
          if (await this.inUse(directory)) return
          await rm(directory, { recursive: true, force: true })
        }
        for (const path of await this.cudaCacheFiles()) await rm(path, { force: true })
        updateAccel((state) => {
          state.cuda.removePending = false
          if (state.activeVariant?.startsWith('cuda')) state.activeVariant = 'vulkan'
        })
      })
    return this.cleaning
  }
  async removeCuda(): Promise<void> {
    setCudaDisabled(true)
    for (const variant of ['cuda12', 'cuda13'] as const) this.controllers.get(variant)?.abort(new Error('用户取消 CUDA 下载'))
    await Promise.allSettled([...this.installing].filter(([v]) => v.startsWith('cuda')).map(([, p]) => p))
    await this.install(this.manifest('vulkan'))
    updateAccel((state) => {
      state.cuda.removePending = true
    })
    await this.cleanup()
  }
  async retryCuda(): Promise<void> {
    retryCudaDownloads()
    this.attemptedCuda = false
    this.nvidia = null
    this.upgraded.clear()
    const desired = chooseVariant(this.environment.platform, this.environment.arch, await this.environment.detect())
    if (!desired.startsWith('cuda')) throw new Error('未检测到兼容 CUDA 的 NVIDIA 显卡或驱动')
    await this.installPreferred(desired)
  }
  redetect(): void {
    this.nvidia = null
    this.upgraded.clear()
    notifyComputeChanged()
  }
  async prepareVulkan(): Promise<void> {
    await this.install(this.manifest('vulkan'))
  }
  async fallback(excludeDirectory: string): Promise<RuntimeInstallation | null> {
    for (const variant of ['vulkan', 'cpu'] as const) {
      const installed = await this.installed(variant)
      if (installed && installed.directory !== excludeDirectory) return installed
    }
    const directory = join(this.environment.directory(), `llama-${LLAMA_BUILD}`)
    if (directory === excludeDirectory || !(await exists(directory))) return null
    const binary = await findBinary(directory, this.binaryName())
    return binary
      ? {
          binary,
          directory,
          variant: this.environment.platform === 'darwin' && this.environment.arch === 'arm64' ? 'metal' : 'cpu',
          legacy: true
        }
      : null
  }
  async cudaBytes(): Promise<number> {
    const size = async (directory: string): Promise<number> => {
      if (!(await exists(directory))) return 0
      let total = 0
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) total += await size(path)
        else if (entry.isFile())
          total += await stat(path).then(
            (s) => s.size,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return 0
              throw error
            }
          )
      }
      return total
    }
    let total = 0
    for (const directory of await this.cudaDirectories()) total += await size(directory)
    for (const path of await this.cudaCacheFiles())
      total += await stat(path).then(
        (s) => s.size,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return 0
          throw error
        }
      )
    return total
  }
  private async cudaDirectories(): Promise<string[]> {
    const root = this.environment.directory()
    if (!(await exists(root))) return []
    const owned = new RegExp(`^llama-${LLAMA_BUILD}-cuda(?:12|13)(?:\\.(?:install|previous)-[0-9a-f-]+)?$`)
    return (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && owned.test(e.name))
      .map((e) => join(root, e.name))
  }
  private async cudaCacheFiles(): Promise<string[]> {
    const directory = join(this.environment.directory(), '.llama-downloads')
    if (!(await exists(directory))) return []
    const files =
      this.environment.platform === 'win32'
        ? [...this.manifest('cuda12').archives, ...this.manifest('cuda13').archives].map((a) => a.file)
        : [ASSETS.cuda12, ASSETS.cuda12rt, ASSETS.cuda13, ASSETS.cuda13rt].map((a) => a.file)
    return (await readdir(directory, { withFileTypes: true }))
      .filter(
        (e) =>
          e.isFile() &&
          files.some((file) => {
            if (!e.name.startsWith(file)) return false
            const suffix = e.name.slice(file.length)
            return suffix === '' || suffix === '.part' || /^\.part\.\d+-\d+$/.test(suffix)
          })
      )
      .map((e) => join(directory, e.name))
  }
}

export const runtimeManager = new LlamaRuntimeManager()
export const llamaSupported = (): boolean =>
  ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'].includes(`${process.platform}-${process.arch}`)
export const serverBinary = async (): Promise<string | null> => (await runtimeManager.current())?.binary ?? null
export const runtimeDownloadSize = (): Promise<number> => runtimeManager.downloadSize()
export const ensureRuntime = async (onProgress: (p: DownloadProgress) => void): Promise<string> =>
  (await runtimeManager.ensure(onProgress)).binary
