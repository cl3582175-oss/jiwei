import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { setTimeout as delay } from 'timers/promises'
import log from 'electron-log/main'
import type { ComputeMode, ComputeService, ComputeServiceStatus } from '@shared/localCompute'
import { getSettings } from '../settings'
import { computeArgs, gpuFailure, markGpuFailure, notifyComputeChanged, parseComputeLog } from './accel'
import { runtimeManager, type RuntimeInstallation } from './llamaRuntime'

export interface RuntimeOwner {
  ensure(): Promise<RuntimeInstallation>
  retain(runtime: RuntimeInstallation): void
  release(runtime: RuntimeInstallation): Promise<void>
  markHealthy(runtime: RuntimeInstallation): Promise<void>
  fallback(excludeDirectory: string): Promise<RuntimeInstallation | null>
  prepareVulkan(): Promise<void>
  onInstalled(listener: (runtime: RuntimeInstallation) => void): () => void
}
interface ServerOptions {
  service: ComputeService
  args: () => string[]
  healthTimeoutMs: number
  idleMs?: number
  computeMode?: ComputeMode
  recover?: boolean
  publishStatus?: boolean
  beforeSpawn?: () => void
  onSpawn?: (child: ChildProcess) => void
  onReady?: () => void
  onExit?: () => void
}
interface Session {
  epoch: number
  child: ChildProcess
  runtime: RuntimeInstallation
  mode: ComputeMode
  url: string
  logs: string
  failure: Error | null
  exited: boolean
  healthy: boolean
  closed: Promise<void>
  stopping: boolean
}
class StoppedError extends Error {
  constructor() {
    super('本地模型服务已停止')
  }
}

const instances = new Set<LlamaServer>()
const services = new Map<ComputeService, LlamaServer>()
process.on('exit', () => {
  for (const instance of instances) instance.killOnExit()
})

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

const aborted = (signal?: AbortSignal): void => {
  signal?.throwIfAborted()
}
async function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  aborted(signal)
  if (!signal) return pending
  let rejectAbort: () => void = () => undefined
  const cancellation = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(signal.reason ?? new Error('已取消'))
  })
  signal.addEventListener('abort', rejectAbort, { once: true })
  try {
    return await Promise.race([pending, cancellation])
  } finally {
    signal.removeEventListener('abort', rejectAbort)
  }
}

/** Process identity, request draining and recovery are shared by both real model services. */
export class LlamaServer {
  private session: Session | null = null
  private ready = false
  private starting: Promise<void> | null = null
  private recovering: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private healthAbort: AbortController | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private active = 0
  private epoch = 0
  private key = ''
  private pendingRestart = false
  private idleWaiters = new Set<() => void>()
  private unsubscribe: () => void
  private status: ComputeServiceStatus

  constructor(
    private options: ServerOptions,
    private owner: RuntimeOwner = runtimeManager
  ) {
    this.status = {
      service: options.service,
      state: 'idle',
      mode: 'auto',
      variant: null,
      backend: null,
      device: null,
      offloadedLayers: null,
      totalLayers: null,
      reason: null,
      pendingRestart: false
    }
    instances.add(this)
    if (options.publishStatus !== false) services.set(options.service, this)
    this.unsubscribe = owner.onInstalled((runtime) => {
      if (this.session && this.session.runtime.directory !== runtime.directory) this.invalidate()
    })
  }

  private configuredMode(): ComputeMode {
    return this.options.computeMode ?? getSettings().ai.localCompute ?? 'auto'
  }
  private configuration(): string {
    return JSON.stringify([this.configuredMode(), this.options.args()])
  }
  private changed(patch: Partial<ComputeServiceStatus>): void {
    this.status = { ...this.status, ...patch, pendingRestart: this.pendingRestart }
    if (this.options.publishStatus !== false) notifyComputeChanged()
  }
  snapshot(): ComputeServiceStatus {
    return { ...this.status, pendingRestart: this.pendingRestart }
  }
  isRunning(): boolean {
    return this.ready && !!this.session && !this.session.exited
  }
  killOnExit(): void {
    this.session?.child.kill()
  }

  invalidate(): void {
    this.pendingRestart = true
    this.changed({})
    if (!this.active && !this.starting && !this.recovering) void this.stop().catch((error) => log.warn('[llama] deferred restart', error))
  }
  private async waitForIdle(signal?: AbortSignal): Promise<void> {
    let done: () => void = () => undefined
    const idle = new Promise<void>((resolve) => {
      done = resolve
      this.idleWaiters.add(done)
    })
    try {
      await withAbort(idle, signal)
    } finally {
      this.idleWaiters.delete(done)
    }
  }
  private async enter(signal?: AbortSignal): Promise<void> {
    if (this.isRunning() && this.key !== this.configuration()) this.invalidate()
    if (this.isRunning() && this.session?.mode === 'auto' && gpuFailure(this.session.runtime.variant, this.options.service))
      this.invalidate()
    while (this.pendingRestart && this.active) await this.waitForIdle(signal)
    if (this.stopping) await withAbort(this.stopping, signal)
    if (this.pendingRestart && !this.active) await this.stop()
    aborted(signal)
    this.active++
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
  private async leave(): Promise<void> {
    this.active--
    if (this.active) return
    if (this.isRunning() && this.key !== this.configuration()) this.pendingRestart = true
    if (this.pendingRestart) await this.stop()
    else this.scheduleIdle()
    for (const done of this.idleWaiters) done()
    this.idleWaiters.clear()
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.options.idleMs || !this.session || this.active) return
    this.idleTimer = setTimeout(() => {
      void this.stop().catch((e) => log.warn('[llama] idle stop', e))
    }, this.options.idleMs)
    this.idleTimer.unref()
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.isRunning()) return
    if (this.starting) return this.starting
    const epoch = this.epoch
    const pending = this.boot(epoch)
    this.starting = pending
    try {
      await pending
    } finally {
      if (this.starting === pending) this.starting = null
      if (this.pendingRestart && !this.active) await this.stop()
    }
  }

  private async boot(epoch: number): Promise<void> {
    const runtime = await this.owner.ensure()
    if (epoch !== this.epoch) throw new StoppedError()
    const mode =
      this.configuredMode() === 'cpu' || runtime.variant === 'cpu' || gpuFailure(runtime.variant, this.options.service) ? 'cpu' : 'auto'
    try {
      await this.launch(runtime, mode, epoch)
    } catch (error) {
      await this.terminate(this.session)
      if (epoch !== this.epoch || error instanceof StoppedError) throw new StoppedError()
      if (mode === 'cpu' || this.options.recover === false) {
        this.changed({ state: 'error', reason: error instanceof Error ? error.message : String(error) })
        throw error
      }
      await this.recover(runtime, error, epoch)
    }
  }

  private async recover(runtime: RuntimeInstallation, error: unknown, epoch: number): Promise<void> {
    if (epoch !== this.epoch) throw new StoppedError()
    const reason = error instanceof Error ? error.message : String(error)
    markGpuFailure(runtime.variant, this.options.service, reason)
    this.changed({ reason })
    try {
      await this.launch(runtime, 'cpu', epoch)
    } catch (cpuError) {
      await this.terminate(this.session)
      const fallback = runtime.variant.startsWith('cuda') ? await this.owner.fallback(runtime.directory) : null
      if (!fallback) {
        this.changed({ state: 'error', reason: cpuError instanceof Error ? cpuError.message : String(cpuError) })
        throw cpuError
      }
      await this.launch(fallback, 'cpu', epoch)
    }
    if (runtime.variant.startsWith('cuda'))
      void this.owner.prepareVulkan().catch((e) => log.warn('[llama] Vulkan fallback download deferred', e))
  }

  private async launch(runtime: RuntimeInstallation, mode: ComputeMode, epoch: number): Promise<void> {
    if (epoch !== this.epoch) throw new StoppedError()
    const port = await freePort()
    if (epoch !== this.epoch) throw new StoppedError()
    const args = [
      ...this.options.args(),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      // b11491 defaults to level 3, which suppresses actual device/offload diagnostics.
      '-lv',
      '4',
      ...computeArgs(mode, runtime.variant, this.options.service)
    ]
    this.options.beforeSpawn?.()
    this.owner.retain(runtime)
    let child: ChildProcess
    try {
      child = spawn(runtime.binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      await this.owner.release(runtime)
      throw error
    }
    let close: () => void = () => undefined
    const session: Session = {
      epoch,
      child,
      runtime,
      mode,
      url: `http://127.0.0.1:${port}`,
      logs: '',
      failure: null,
      exited: false,
      healthy: false,
      stopping: false,
      closed: new Promise<void>((resolve) => {
        close = resolve
      })
    }
    this.session = session
    this.key = this.configuration()
    this.ready = false
    this.pendingRestart = false
    this.changed({
      state: 'starting',
      mode,
      variant: runtime.variant,
      backend: mode === 'cpu' ? 'cpu' : null,
      device: mode === 'cpu' ? 'CPU' : null,
      offloadedLayers: mode === 'cpu' ? 0 : null,
      totalLayers: null,
      reason: mode === 'cpu' ? gpuFailure(runtime.variant, this.options.service) : null
    })
    child.stderr?.on('data', (data: Buffer) => {
      session.logs = (session.logs + data.toString()).slice(-24_000)
      if (this.session !== session) return
      const diagnostics = parseComputeLog(session.logs)
      if (mode === 'cpu') {
        diagnostics.backend = 'cpu'
        diagnostics.device = 'CPU'
        diagnostics.offloadedLayers = 0
      }
      this.changed(diagnostics)
    })
    child.once('error', (error) => {
      session.failure = error
    })
    child.once('exit', (code, signal) => {
      session.exited = true
      if (!session.stopping) session.failure = new Error(`本地模型进程退出 (${code ?? signal})：${session.logs.slice(-600)}`)
      if (this.session === session) this.ready = false
    })
    child.once('close', () => {
      session.exited = true
      void this.owner
        .release(runtime)
        .catch((error) => log.warn('[llama] runtime release deferred', error))
        .finally(close)
      if (this.session !== session) return
      this.session = null
      this.ready = false
      this.options.onExit?.()
      this.changed({
        state: session.stopping ? 'idle' : 'error',
        backend: null,
        device: null,
        offloadedLayers: null,
        totalLayers: null,
        reason: session.failure?.message ?? this.status.reason
      })
      if (session.healthy && !session.stopping && session.mode === 'auto' && this.options.recover !== false) {
        try {
          markGpuFailure(runtime.variant, this.options.service, session.failure?.message ?? 'GPU 进程意外退出')
          if (!this.active)
            queueMicrotask(() => {
              if (epoch !== this.epoch) return
              void this.start()
                .then(() => this.scheduleIdle())
                .catch((error) => log.warn('[llama] idle GPU recovery failed', error))
            })
        } catch (error) {
          log.warn('[llama] cannot persist GPU failure', error)
        }
      }
    })
    this.options.onSpawn?.(child)
    const controller = new AbortController()
    this.healthAbort = controller
    const deadline = Date.now() + this.options.healthTimeoutMs
    for (;;) {
      if (epoch !== this.epoch || controller.signal.aborted) throw new StoppedError()
      if (session.failure || session.exited) throw session.failure ?? new Error(`本地模型启动失败：${session.logs.slice(-600)}`)
      const healthy = await fetch(`${session.url}/health`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)])
      }).then(
        (r) => r.ok,
        () => false
      )
      if (healthy && this.session === session && !session.exited) {
        session.healthy = true
        this.ready = true
        this.changed({ state: 'running' })
        await this.owner.markHealthy(runtime).catch((error) => log.warn('[llama] runtime cleanup deferred', error))
        this.options.onReady?.()
        return
      }
      if (Date.now() >= deadline) throw new Error(`本地模型启动超时：${session.logs.slice(-600)}`)
      await delay(25)
    }
  }

  async run<T>(request: (url: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.enter(signal)
    try {
      await withAbort(this.start(), signal)
      aborted(signal)
      const session = this.session!
      try {
        return await request(session.url)
      } catch (error) {
        aborted(signal)
        if (session.epoch !== this.epoch) throw error
        const transport = error instanceof TypeError && /fetch|socket|connect/i.test(error.message)
        if (session.mode === 'cpu' || this.options.recover === false || (!session.exited && !session.failure && !transport)) throw error
        if (!this.recovering) {
          this.recovering = (async () => {
            if (this.session !== session && this.isRunning()) return
            await this.terminate(session)
            await this.recover(session.runtime, error, session.epoch)
          })().finally(() => {
            this.recovering = null
          })
        }
        await withAbort(this.recovering, signal)
        aborted(signal)
        return await request(this.session!.url)
      }
    } finally {
      await this.leave()
    }
  }

  private async terminate(session: Session | null): Promise<void> {
    if (!session) return
    session.stopping = true
    if (this.session === session) this.healthAbort?.abort()
    session.child.kill()
    const force = setTimeout(() => {
      session.child.kill('SIGKILL')
    }, 1000)
    force.unref()
    try {
      await session.closed
    } finally {
      clearTimeout(force)
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.epoch++
    this.healthAbort?.abort()
    this.pendingRestart = false
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const pending = this.terminate(this.session)
      .then(() => {
        this.ready = false
        this.changed({ state: 'idle', backend: null, device: null, offloadedLayers: null, totalLayers: null })
      })
      .finally(() => {
        this.stopping = null
      })
    this.stopping = pending
    return pending
  }
  async dispose(): Promise<void> {
    await this.stop()
    this.unsubscribe()
    instances.delete(this)
    if (services.get(this.options.service) === this) services.delete(this.options.service)
  }
}

export function computeServers(): ReadonlyMap<ComputeService, LlamaServer> {
  return services
}
export function invalidateComputeServers(): void {
  for (const server of services.values()) server.invalidate()
}
