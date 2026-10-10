import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const state = vi.hoisted(() => ({ root: '', failNative: true, downloads: 0 }))
vi.mock('electron', () => ({ net: {} }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('../../db', () => ({ getDb: vi.fn() }))
vi.mock('../../events', () => ({ emit: vi.fn() }))
vi.mock('../../services/recording', () => ({ recordingAudio: vi.fn() }))
vi.mock('../../services/moss', () => ({ enqueueMoss: vi.fn(), mossStatus: () => ({ state: 'missing' }) }))
vi.mock('../../services/voiceMessages', () => ({ voiceText: (key: string) => key }))
vi.mock('../../services/ai/localEmbedding', () => ({ modelsDir: () => state.root }))
vi.mock('../../services/assets', () => ({ assetPath: vi.fn() }))
vi.mock('../../services/jobs', () => ({ enqueue: vi.fn(), registerJobKind: vi.fn() }))
vi.mock('../../services/segments', () => ({ listSegments: vi.fn(), replaceSegments: vi.fn() }))
vi.mock('../../services/ai/indexer', () => ({ requestIndex: vi.fn() }))
vi.mock('../../services/ai/providers', () => ({ decryptKey: vi.fn(), getProviderRow: vi.fn() }))
vi.mock('../../services/settings', () => ({ getSettings: vi.fn() }))
// 仅替换下载/解包边界，真实目录、失败残留与重试发布都由安装服务执行。
vi.mock('../../services/download', () => ({
  download: async ({ name, dest }: { name: string; dest: string }) => {
    state.downloads++
    if (name !== 'sherpa-onnx-node' && state.failNative) throw new Error('native download interrupted')
    await writeFile(dest, 'verified fixture archive')
  }
}))
vi.mock('tar', () => ({
  x: async ({ cwd }: { cwd: string }) => {
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'package.json'), '{}')
    await writeFile(join(cwd, 'complete'), 'extracted')
  }
}))
import { ensureSherpaRuntime, asrPaths } from '../../services/asr'
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'jiwei-voice-runtime-'))
  state.failNative = true
  state.downloads = 0
})
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})
it('原生包下载中断后重试必须补齐运行时，不能仅凭 JS package.json 当安装成功', async () => {
  await expect(ensureSherpaRuntime()).rejects.toThrow('native download interrupted')
  expect(existsSync(asrPaths().runtime)).toBe(false)
  state.failNative = false
  await ensureSherpaRuntime()
  const runtime = asrPaths().runtime
  expect(
    existsSync(
      join(runtime, 'node_modules', `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`, 'complete')
    )
  ).toBe(true)
  expect(await readFile(join(runtime, 'node_modules/sherpa-onnx-node/complete'), 'utf8')).toBe('extracted')
  expect(state.downloads).toBe(4)
})
