import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { c as tar } from 'tar'
import type { RuntimeVariant } from '@shared/localCompute'

const fixture = vi.hoisted(() => ({ root: '', mode: 'auto' as 'auto' | 'cpu', failRenameTarget: null as string | null }))
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      if (fixture.failRenameTarget === String(to) && String(from).includes('.install-'))
        throw Object.assign(new Error('rename denied'), { code: 'EIO' })
      return actual.rename(from, to)
    }
  }
})
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('../../settings', () => ({ getSettings: () => ({ ai: { localCompute: fixture.mode } }) }))
vi.mock('../../download', () => ({ download: vi.fn(), sha256File: vi.fn() }))
import { loadAccel, modelsDir, parseNvidia, resetHealth, setCudaDisabled } from '../accel'
import { LlamaRuntimeManager, runtimeSpec, type RuntimeArchive, type RuntimeSpec } from '../llamaRuntime'

let archives: Map<string, Buffer>
let specs: Map<RuntimeVariant, RuntimeSpec>
let requested: string[]

beforeEach(async () => {
  fixture.root = mkdtempSync(join(tmpdir(), 'jiwei-runtime-'))
  fixture.mode = 'auto'
  fixture.failRenameTarget = null
  archives = new Map()
  specs = new Map()
  requested = []
  for (const variant of ['cuda13', 'cuda12', 'vulkan', 'cpu', 'metal'] as const) {
    const zip = new JSZip()
    zip.file('bin/llama-server.exe', `fixture-${variant}`)
    zip.file('bin/ggml-cpu.dll', 'cpu backend')
    const files = [await archive(`${variant}.zip`, await zip.generateAsync({ type: 'nodebuffer' }))]
    if (variant.startsWith('cuda')) {
      const support = new JSZip().file('bin/cudart.dll', 'cuda support fixture')
      files.push(await archive(`${variant}-cudart.zip`, await support.generateAsync({ type: 'nodebuffer' })))
    }
    specs.set(variant, { variant, archives: files })
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(fixture.root, { recursive: true, force: true })
})

async function archive(file: string, bytes: Buffer): Promise<RuntimeArchive> {
  archives.set(file, bytes)
  return { file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
function manager(options: { download?: (file: string) => Promise<void>; probe?: () => Promise<void> } = {}) {
  return new LlamaRuntimeManager(
    {
      platform: 'win32',
      arch: 'x64',
      directory: modelsDir,
      detect: async () => parseNvidia('NVIDIA RTX 3060, 580.01, 8.6, 12288 MiB'),
      mode: () => fixture.mode
    },
    {
      download: async (spec, progress) => {
        requested.push(spec.name)
        await options.download?.(spec.name)
        mkdirSync(join(spec.dest, '..'), { recursive: true })
        const bytes = archives.get(spec.name)!
        writeFileSync(spec.dest, bytes)
        progress({ received: bytes.length, total: bytes.length, speed: 1000, mirror: 'fixture' })
      },
      probe: async () => {
        await options.probe?.()
        return []
      }
    },
    (variant) => specs.get(variant)!
  )
}
function legacy() {
  const directory = join(modelsDir(), 'llama-b11491')
  mkdirSync(join(directory, 'bin'), { recursive: true })
  writeFileSync(join(directory, 'bin/llama-server.exe'), 'existing CPU runtime')
  return directory
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('pinned release assets', () => {
  it('rejects backend/platform combinations that have no real runtime package', () => {
    expect(() => runtimeSpec('cuda13', 'darwin', 'arm64')).toThrow(/不支持/)
    expect(() => runtimeSpec('metal', 'darwin', 'x64')).toThrow(/不支持/)
  })
  it('includes both CUDA archives and actual GitHub size/digest', () => {
    const spec = runtimeSpec('cuda13', 'win32', 'x64')
    expect(spec.archives.reduce((sum, f) => sum + f.size, 0)).toBe(576844403)
    expect(spec.archives.map((f) => f.sha256)).toEqual([
      '82f52784db12499418150837829ff0f8b6e4307db4410217fc6de891a1c4bd27',
      '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668'
    ])
    expect(runtimeSpec('cuda12', 'win32', 'x64').archives.reduce((n, f) => n + f.size, 0)).toBe(656403603)
    expect(runtimeSpec('vulkan', 'linux', 'x64').archives[0]).toMatchObject({
      file: 'llama-b11491-bin-ubuntu-vulkan-x64.tar.gz',
      size: 31736217,
      sha256: 'cb91f3ee4935b68ebf95554a228440efb9dc5fbeb62af7e5076e10b6d28e715b'
    })
  })
})

describe('transactional installation', () => {
  it('restores an existing target if the final directory rename fails', async () => {
    const target = join(modelsDir(), 'llama-b11491-vulkan')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'sentinel'), 'preserve')
    fixture.failRenameTarget = target
    await expect(manager().install(specs.get('vulkan')!)).rejects.toThrow(/rename denied/)
    expect(existsSync(join(target, 'sentinel'))).toBe(true)
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('preserve')
  })
  it('installs CUDA and cudart into one complete directory and reports combined progress', async () => {
    const runtime = manager()
    const total = specs.get('cuda13')!.archives.reduce((n, a) => n + a.size, 0)
    expect(await runtime.downloadSize()).toBe(total)
    const seen: { received: number; total: number }[] = []
    const result = await runtime.ensure((p) => seen.push(p))
    expect(result.variant).toBe('cuda13')
    expect(readFileSync(result.binary, 'utf8')).toBe('fixture-cuda13')
    expect(existsSync(join(result.directory, 'bin/cudart.dll'))).toBe(true)
    expect(seen.at(-1)).toMatchObject({ received: total, total })
    expect(seen.every((p) => p.total === total && p.received <= total)).toBe(true)
    expect(await runtime.downloadSize()).toBe(0)
    expect(JSON.parse(readFileSync(join(result.directory, 'runtime.json'), 'utf8')).archives).toHaveLength(2)
  })
  it('single-flights concurrent installs without overwriting partial archives or receipts', async () => {
    const runtime = manager()
    const [a, b] = await Promise.all([runtime.ensure(), runtime.ensure()])
    expect(a.binary).toBe(b.binary)
    expect(requested).toEqual(['cuda13.zip', 'cuda13-cudart.zip'])
    expect((await runtime.installed('cuda13'))?.binary).toBe(a.binary)
  })
  it('rejects a corrupt archive before extraction and falls back to complete Vulkan', async () => {
    const runtime = manager({
      download: async (file) => {
        if (file === 'cuda13-cudart.zip') archives.set(file, Buffer.from('corrupt'))
      }
    })
    const result = await runtime.ensure()
    expect(result.variant).toBe('vulkan')
    expect(await runtime.installed('cuda13')).toBeNull()
    expect(loadAccel().cuda.failures).toBe(1)
    expect(existsSync(join(modelsDir(), 'llama-b11491-cuda13'))).toBe(false)
  })
  it('never treats a directory without its complete matching receipt as installed', async () => {
    const directory = join(modelsDir(), 'llama-b11491-cuda13')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'llama-server.exe'), 'partial')
    expect(await manager().installed('cuda13')).toBeNull()
  })
  it('rejects ZIP traversal before any extracted entry can escape staging', async () => {
    const zip = new JSZip().file('../escaped.txt', 'unsafe').file('llama-server.exe', 'binary')
    specs.set('vulkan', { variant: 'vulkan', archives: [await archive('unsafe.zip', await zip.generateAsync({ type: 'nodebuffer' }))] })
    const runtime = manager()
    await expect(runtime.install(specs.get('vulkan')!)).rejects.toThrow(/路径/)
    expect(existsSync(join(modelsDir(), 'escaped.txt'))).toBe(false)
    expect(await runtime.installed('vulkan')).toBeNull()
  })
  it('rejects tar links escaping staging and preserves unrelated files', async () => {
    const source = join(fixture.root, 'tar-source')
    mkdirSync(source)
    writeFileSync(join(fixture.root, 'sentinel'), 'keep')
    symlinkSync('../sentinel', join(source, 'evil'))
    const chunks: Buffer[] = []
    for await (const chunk of tar({ cwd: source, gzip: true }, ['evil'])) chunks.push(Buffer.from(chunk))
    specs.set('vulkan', { variant: 'vulkan', archives: [await archive('unsafe.tar.gz', Buffer.concat(chunks))] })
    await expect(manager().install(specs.get('vulkan')!)).rejects.toThrow(/路径/)
    expect(readFileSync(join(fixture.root, 'sentinel'), 'utf8')).toBe('keep')
  })
})

describe('upgrade, offline recovery and opt-out', () => {
  it('accounts for cached CUDA download bytes and removes only its owned cache files', async () => {
    legacy()
    const runtime = manager({
      download: async (file) => {
        if (file === 'cuda13-cudart.zip') throw new Error('offline')
      }
    })
    await runtime.ensure()
    await runtime.waitForUpgrade()
    const cache = join(modelsDir(), '.llama-downloads')
    writeFileSync(join(cache, 'unrelated.zip'), 'keep')
    expect(await runtime.cudaBytes()).toBe(archives.get('cuda13.zip')!.length)
    await runtime.removeCuda()
    expect(await runtime.cudaBytes()).toBe(0)
    expect(readFileSync(join(cache, 'unrelated.zip'), 'utf8')).toBe('keep')
  })
  it('keeps old runtime serving until a healthy replacement exists and every lease is released', async () => {
    const old = legacy(),
      gate = deferred()
    const runtime = manager({ download: async () => gate.promise })
    const existing = await runtime.ensure()
    expect(existing.directory).toBe(old)
    expect(existing.legacy).toBe(true)
    runtime.retain(existing)
    gate.resolve()
    await runtime.waitForUpgrade()
    const replacement = (await runtime.installed('cuda13'))!
    expect(existsSync(old)).toBe(true)
    await runtime.markHealthy(replacement)
    expect(existsSync(old)).toBe(true)
    await runtime.release(existing)
    expect(existsSync(old)).toBe(false)
  })
  it('complete offline upgrade preserves old CPU usability and does not count multiple retries in one startup', async () => {
    const old = legacy()
    const runtime = manager({
      download: async () => {
        throw new Error('offline')
      }
    })
    expect((await runtime.ensure()).directory).toBe(old)
    await runtime.waitForUpgrade()
    expect((await runtime.ensure()).directory).toBe(old)
    await runtime.waitForUpgrade()
    expect(loadAccel().cuda.failures).toBe(1)
    expect(existsSync(old)).toBe(true)
    expect(runtime.snapshot().error).toMatch(/offline/)
  })
  it('new offline install fails explicitly rather than fabricating an available CPU runtime', async () => {
    const runtime = manager({
      download: async () => {
        throw new Error('offline')
      }
    })
    await expect(runtime.ensure()).rejects.toThrow(/offline/)
    expect(await runtime.current()).toBeNull()
  })
  it('stops automatic CUDA attempts after three failed startups and honors explicit user opt-out', async () => {
    legacy()
    for (let startup = 0; startup < 3; startup++) {
      const runtime = manager({
        download: async () => {
          throw new Error('offline')
        }
      })
      await runtime.ensure()
      await runtime.waitForUpgrade()
    }
    expect(loadAccel().cuda.failures).toBe(3)
    const stopped = manager({
      download: async () => {
        throw new Error('offline')
      }
    })
    expect(await stopped.desired()).toBe('vulkan')
    setCudaDisabled(true)
    resetHealth()
    expect(await manager().desired()).toBe('vulkan')
  })
  it('deletes CUDA only after safe Vulkan fallback and the running CUDA process releases it', async () => {
    const runtime = manager()
    const cuda = await runtime.ensure()
    await runtime.markHealthy(cuda)
    runtime.retain(cuda)
    await runtime.removeCuda()
    expect(loadAccel().cuda.disabled).toBe(true)
    expect(await runtime.installed('vulkan')).not.toBeNull()
    expect(existsSync(cuda.directory)).toBe(true)
    await runtime.release(cuda)
    expect(existsSync(cuda.directory)).toBe(false)
    expect(await manager().desired()).toBe('vulkan')
  })
  it('CPU preference does not silently download hundreds of MB of unused CUDA', async () => {
    fixture.mode = 'cpu'
    const result = await manager().ensure()
    expect(result.variant).toBe('cpu')
    expect(requested).toEqual(['cpu.zip'])
  })

  it('user cancellation does not count as a failed automatic CUDA download', async () => {
    const started = deferred(),
      gate = deferred()
    const runtime = manager({
      download: async (file) => {
        if (file.startsWith('cuda')) {
          started.resolve()
          await gate.promise
        }
      }
    })
    const pending = runtime.ensure().catch((error: unknown) => error)
    await started.promise
    const removing = runtime.removeCuda()
    gate.resolve()
    await removing
    expect(await pending).toBeInstanceOf(Error)
    expect(loadAccel().cuda.failures).toBe(0)
  })
})
