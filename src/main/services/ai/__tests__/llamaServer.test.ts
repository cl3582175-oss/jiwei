import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { setTimeout as delay } from 'timers/promises'
import type { RuntimeInstallation } from '../llamaRuntime'

const fixture = vi.hoisted(() => ({ root: '', mode: 'auto' as 'auto' | 'cpu' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../settings', () => ({ getSettings: () => ({ ai: { localCompute: fixture.mode } }) }))
vi.mock('../llamaRuntime', () => ({ runtimeManager: {} }))
import { gpuFailure, updateAccel } from '../accel'
import { LlamaServer, type RuntimeOwner } from '../llamaServer'

let servers: LlamaServer[]
let owner: RuntimeOwner
let leased: number
const script = resolve('src/main/services/ai/__tests__/fixtures/llama-server.mjs')
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'jiwei-llama-process-'))
  fixture.mode = 'auto'
  servers = []
  leased = 0
  const runtime: RuntimeInstallation = { binary: process.execPath, directory: fixture.root, variant: 'metal', legacy: false }
  owner = {
    ensure: async () => runtime,
    retain: () => {
      leased++
    },
    release: async () => {
      leased--
    },
    markHealthy: async () => undefined,
    fallback: async () => null,
    prepareVulkan: async () => undefined,
    onInstalled: () => () => undefined
  }
})
afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()))
  expect(leased).toBe(0)
  rmSync(fixture.root, { recursive: true, force: true })
})
function server(failure = 'none', extra: string[] = []) {
  const instance = new LlamaServer(
    {
      service: 'embedding',
      args: () => [script, '--fixture-failure', failure, '--fixture-trace', join(fixture.root, 'trace'), '-c', '32768', ...extra],
      healthTimeoutMs: 500
    },
    owner
  )
  servers.push(instance)
  return instance
}
type Response = { cpu: boolean; args: string[]; pid: number; fixture: true }
const request = async (url: string): Promise<Response> => (await fetch(`${url}/args`)).json()
function starts(): { args: string[]; pid: number }[] {
  return readFileSync(join(fixture.root, 'trace'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

it('enables b11491 device and offload diagnostics for actual settings status', async () => {
  const result = await server().run(request)
  expect(result.args.slice(result.args.indexOf('-lv'), result.args.indexOf('-lv') + 2)).toEqual(['-lv', '4'])
})

it('passes explicit auto fit arguments through the real spawn/HTTP path and preserves context', async () => {
  const instance = server()
  const result = await instance.run(request)
  expect(result.cpu).toBe(false)
  expect(result.args).toContain('--fit-target')
  expect(result.args[result.args.indexOf('-c') + 1]).toBe('32768')
  expect(instance.snapshot()).toMatchObject({
    state: 'running',
    backend: 'metal',
    device: 'Fixture GPU',
    offloadedLayers: 25,
    totalLayers: 25
  })
})
it('single-flights concurrent model starts and leases the runtime per process', async () => {
  const instance = server()
  const [a, b] = await Promise.all([instance.run(request), instance.run(request)])
  expect(a.pid).toBe(b.pid)
  expect(starts()).toHaveLength(1)
  expect(leased).toBe(1)
})
it('GPU initialization failure retries once on CPU and persists the recovery reason', async () => {
  const instance = server('launch')
  expect((await instance.run(request)).cpu).toBe(true)
  expect(starts()).toHaveLength(2)
  expect(gpuFailure('metal', 'embedding')).toMatch(/fixture GPU initialization failure/)
  expect(instance.snapshot()).toMatchObject({ state: 'running', mode: 'cpu', backend: 'cpu', offloadedLayers: 0 })
})
it('GPU health timeout terminates the old process and retries CPU once', async () => {
  const instance = server('health')
  expect((await instance.run(request)).cpu).toBe(true)
  expect(starts()).toHaveLength(2)
  expect(gpuFailure('metal', 'embedding')).toMatch(/超时/)
  expect(instance.isRunning()).toBe(true)
})
it('a running GPU process crash retries the request on CPU before returning its result', async () => {
  const instance = server('crash')
  const result = await instance.run(async (url) => (await fetch(`${url}/crash`)).json() as Promise<Response>)
  expect(result.cpu).toBe(true)
  expect(starts()).toHaveLength(2)
})

it('an idle GPU crash is also persisted so the next task does not silently relaunch the failed GPU', async () => {
  const instance = server('crash')
  let base = ''
  await instance.run((url) => {
    base = url
    return request(url)
  })
  await fetch(`${base}/crash`).catch(() => undefined)
  for (let i = 0; i < 50 && !gpuFailure('metal', 'embedding'); i++) await delay(5)
  expect(gpuFailure('metal', 'embedding')).not.toBeNull()
  expect((await instance.run(request)).cpu).toBe(true)
})
it('propagates CPU failure without an unbounded restart loop', async () => {
  const instance = server('both')
  await expect(instance.run(request)).rejects.toThrow(/fixture GPU initialization failure/)
  expect(starts()).toHaveLength(2)
  expect(instance.isRunning()).toBe(false)
})
it('does not poison GPU health when the user cancels a live request', async () => {
  const instance = server()
  await instance.run(request)
  const abort = new AbortController()
  const pending = instance.run((url) => fetch(`${url}/slow`, { signal: abort.signal }), abort.signal)
  abort.abort(new Error('user cancelled'))
  await expect(pending).rejects.toThrow(/cancelled/)
  expect(gpuFailure('metal', 'embedding')).toBeNull()
  expect(instance.isRunning()).toBe(true)
})

it('explicit service shutdown never resurrects a process or records a GPU fault', async () => {
  const waiting = join(fixture.root, 'waiting')
  const instance = server('none', ['--fixture-waiting', waiting])
  let settled = false
  const outcome = instance
    .run((url) => fetch(`${url}/wait`))
    .then(
      () => null,
      (error: unknown) => error
    )
    .finally(() => {
      settled = true
    })
  for (let i = 0; i < 100 && !existsSync(waiting); i++) await delay(5)
  expect(existsSync(waiting)).toBe(true)
  await instance.stop()
  for (let i = 0; i < 50 && !settled && starts().length < 2; i++) await delay(5)
  expect(starts()).toHaveLength(1)
  expect(await outcome).toBeInstanceOf(Error)
  expect(instance.isRunning()).toBe(false)
  expect(gpuFailure('metal', 'embedding')).toBeNull()
})
it('switching settings preserves an in-flight request and queues new work until CPU is ready', async () => {
  const waiting = join(fixture.root, 'waiting')
  const instance = server('none', ['--fixture-waiting', waiting])
  let oldUrl = ''
  const active = instance.run(async (url) => {
    oldUrl = url
    return (await fetch(`${url}/wait`)).json() as Promise<Response>
  })
  for (let i = 0; i < 100 && !existsSync(waiting); i++) await delay(10)
  expect(existsSync(waiting)).toBe(true)
  fixture.mode = 'cpu'
  instance.invalidate()
  expect(instance.snapshot().pendingRestart).toBe(true)
  let settled = false
  const next = instance.run(request).then((r) => {
    settled = true
    return r
  })
  await delay(30)
  expect(settled).toBe(false)
  await fetch(`${oldUrl}/release`)
  expect((await active).cpu).toBe(false)
  expect((await next).cpu).toBe(true)
  expect(instance.snapshot().pendingRestart).toBe(false)
})
it('only-CPU starts on CPU directly without ever launching a GPU process', async () => {
  fixture.mode = 'cpu'
  const instance = server('launch')
  expect((await instance.run(request)).cpu).toBe(true)
  expect(starts()).toHaveLength(1)
})

it('a recorded slower-GPU benchmark takes effect on the next actual request', async () => {
  const instance = server()
  expect((await instance.run(request)).cpu).toBe(false)
  updateAccel((s) => {
    s.benchmarks['b11491:metal'] = { gpuMs: 10, cpuMs: 2, useCpu: true }
  })
  expect((await instance.run(request)).cpu).toBe(true)
  expect(starts()).toHaveLength(2)
})

it('a completed background upgrade during initial model loading does not turn installation into a failure', async () => {
  let installed: ((runtime: RuntimeInstallation) => void) | null = null
  owner.onInstalled = (listener) => {
    installed = listener
    return () => undefined
  }
  const instance = server('none', ['--fixture-health-delay', '200'])
  const outcome = instance.start().then(
    () => null,
    (error: unknown) => error
  )
  for (let i = 0; i < 100 && !existsSync(join(fixture.root, 'trace')); i++) await delay(5)
  expect(existsSync(join(fixture.root, 'trace'))).toBe(true)
  installed!({ binary: process.execPath, directory: join(fixture.root, 'replacement'), variant: 'metal', legacy: false })
  expect(await outcome).toBeNull()
  expect(gpuFailure('metal', 'embedding')).toBeNull()
})
