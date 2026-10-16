import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { launchScannedPdfApp } from './fixtures/scannedPdfApp'
import { cosine, launchLocalComputeApp, liveEmbeddings } from './fixtures/localComputeApp'
import { makeImagePdf, scanImage } from './fixtures/makeScanPdf'

const cache = process.env.JIWEI_COMPUTE_CACHE
const evidence = process.env.JIWEI_COMPUTE_EVIDENCE
function save(name: string, value: unknown) {
  if (!evidence) return
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}

async function openComputeSettings(page: Page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await page.getByRole('button', { name: 'AI 模型', exact: true }).click()
  const section = page.getByTestId('local-compute-settings')
  await expect(section).toBeVisible()
  await section.scrollIntoViewIfNeeded()
  return section
}

async function waitForParsedSource(page: Page, id: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => window.jiwei.jobs.list().then((jobs) => jobs.some((job) => job.key === `segment:${id}` && job.status === 'done')),
          id
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
}

test('actual settings UI persists only-CPU and redetect preserves it across app restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jiwei-compute-settings-'))
  let { app, page } = await launchScannedPdfApp(directory)
  try {
    let section = await openComputeSettings(page)
    await section.getByRole('combobox', { name: '计算设备', exact: true }).selectOption('cpu')
    await expect.poll(() => page.evaluate(() => window.jiwei.settings.get().then((s) => s.ai.localCompute))).toBe('cpu')
    const modelRoot = join(directory, 'model-appdata', 'jiwei-models')
    mkdirSync(modelRoot, { recursive: true })
    writeFileSync(
      join(modelRoot, 'accel.json'),
      JSON.stringify({
        version: 1,
        health: { 'b11491:metal:embedding': { reason: 'controlled previous GPU failure', at: Date.now() } },
        benchmarks: {},
        devices: [],
        cuda: { build: 'b11491', failures: 0, disabled: true, preferVulkan: false, reason: null }
      })
    )
    await section.getByRole('button', { name: '重新检测', exact: true }).click()
    await expect.poll(() => Object.keys(JSON.parse(readFileSync(join(modelRoot, 'accel.json'), 'utf8')).health).length).toBe(0)
    expect(JSON.parse(readFileSync(join(modelRoot, 'accel.json'), 'utf8')).cuda.disabled).toBe(true)
    await expect.poll(() => page.evaluate(() => window.jiwei.localCompute.status().then((s) => s.maintenance))).toBeNull()
    expect(await page.evaluate(() => window.jiwei.settings.get().then((s) => s.ai.localCompute))).toBe('cpu')
    await app.close()
    ;({ app, page } = await launchScannedPdfApp(directory))
    section = await openComputeSettings(page)
    await expect(section.getByRole('combobox', { name: '计算设备', exact: true })).toHaveValue('cpu')
    await expect(section.getByTestId('local-compute-embedding')).toContainText('空闲')
    const evidence = process.env.JIWEI_COMPUTE_EVIDENCE
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      await page.screenshot({ path: join(evidence, 'settings-persistence.png') })
    }
  } finally {
    await app.close()
  }
})

test('real Metal and CPU results, fit partial offload, failure recovery and persisted OCR remain usable', async () => {
  test.skip(
    !cache || process.platform !== 'darwin' || process.arch !== 'arm64',
    'Requires an explicitly isolated real-model cache on Apple silicon'
  )
  test.setTimeout(600_000)
  const directory = mkdtempSync(join(tmpdir(), 'jiwei-compute-real-'))
  const live = await launchLocalComputeApp(directory, cache!)
  const { app, page, models, control } = live
  save('real-run', { directory, models })
  try {
    await page.evaluate(async () => {
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: {
          ...s.ai,
          localCompute: 'auto',
          embedding: { mode: 'local', providerId: null, model: null },
          recognition: { mode: 'local', providerId: null, model: null, auto: false, figures: true, localModel: 'fast' }
        },
        retrieval: { ...s.retrieval, autoUpgrade: false }
      })
      await window.jiwei.embedding.installLocal()
    })
    const section = await openComputeSettings(page)
    await expect(section.getByTestId('local-compute-embedding')).toContainText('全部在 GPU')
    await expect(section.getByTestId('local-compute-embedding')).toContainText('Apple M5')
    const texts = [
      '积微帮助我们建立长期记忆。',
      'GPU acceleration preserves the same embedding model identity.',
      '知识检索应引用真实资料。'
    ]
    const gpu = await liveEmbeddings(
      live
        .launches()
        .filter((x) => x.service === 'embedding')
        .at(-1)!,
      texts
    )
    const fullStatus = await page.evaluate(() => window.jiwei.localCompute.status())
    expect(fullStatus.services.embedding.offloadedLayers).toBe(fullStatus.services.embedding.totalLayers)
    const file = join(directory, '真实设备识别.pdf')
    writeFileSync(
      file,
      makeImagePdf([
        { jpeg: scanImage(['积微计算设备验证', '学习记录支持长期记忆', '向量与识别结果需要持久化']), w: 1240, h: 1754, text: [] }
      ])
    )
    const imported = await page.evaluate((path) => window.jiwei.sources.importPaths([path]), file)
    const id = imported.imported[0].id
    await waitForParsedSource(page, id)
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((x) => x.total), id), { timeout: 30_000 })
      .toBeGreaterThan(0)
    await page.evaluate((id) => window.jiwei.recognition.start(id), id)
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((x) => ({ done: x.done, running: x.running })), id), {
        timeout: 180_000,
        intervals: [1000]
      })
      .toEqual({ done: 1, running: false })
    const segments = await page.evaluate((id) => window.jiwei.segments.list(id), id)
    expect(segments.map((x) => x.text).join('\n')).toContain('长期记忆')
    await expect(section.getByTestId('local-compute-recognition')).toContainText('全部在 GPU')
    if (evidence) await page.screenshot({ path: join(evidence, 'real-metal.png') })
    const metalStatus = await page.evaluate(() => window.jiwei.localCompute.status())
    await section.getByRole('combobox', { name: '计算设备', exact: true }).selectOption('cpu')
    await expect(section.getByTestId('local-compute-embedding')).toContainText('CPU')
    await expect(section.getByTestId('local-compute-recognition')).toContainText('CPU')
    await expect
      .poll(() => page.evaluate(() => window.jiwei.localCompute.status().then((s) => s.maintenance)), { timeout: 90_000 })
      .toBeNull()
    const cpuStatus = await page.evaluate(() => window.jiwei.localCompute.status())
    expect(cpuStatus.services.embedding.offloadedLayers).toBe(0)
    expect(cpuStatus.services.recognition.offloadedLayers).toBe(0)
    const cpu = await liveEmbeddings(
      live
        .launches()
        .filter((x) => x.service === 'embedding')
        .at(-1)!,
      texts
    )
    const cpuCosines = gpu.map((x, i) => cosine(x, cpu[i]))
    expect(Math.min(...cpuCosines)).toBeGreaterThan(0.999)
    expect(
      live
        .launches()
        .filter((x) => x.service === 'recognition')
        .at(-1)!.args
    ).toContain('--no-mmproj-offload')
    if (evidence) await page.screenshot({ path: join(evidence, 'real-cpu.png') })
    // A separate imported page exercises actual CPU OCR, persistence and subsequent retrieval.
    const secondFile = join(directory, '仅CPU识别.pdf')
    writeFileSync(
      secondFile,
      makeImagePdf([
        { jpeg: scanImage(['仅CPU识别验证', '学习记录支持长期记忆', '不同资料验证实际识别和持久化']), w: 1240, h: 1754, text: [] }
      ])
    )
    const second = await page.evaluate((path) => window.jiwei.sources.importPaths([path]), secondFile)
    const secondId = second.imported[0].id
    await waitForParsedSource(page, secondId)
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((s) => s.total), id), { timeout: 30_000 })
      .toBeGreaterThan(0)
    await page.evaluate((id) => window.jiwei.recognition.start(id), secondId)
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((s) => s.done), secondId), { timeout: 180_000 })
      .toBe(1)
    expect((await page.evaluate((id) => window.jiwei.segments.list(id), secondId)).map((s) => s.text).join('')).toContain('长期记忆')
    const partialAttempts: unknown[] = []
    let partial: number[][] | null = null
    await section.getByRole('combobox', { name: '计算设备', exact: true }).selectOption('auto')
    await expect
      .poll(() => page.evaluate(() => window.jiwei.localCompute.status().then((s) => s.maintenance)), { timeout: 90_000 })
      .toBeNull()
    for (const fitTarget of [11800, 11900, 12000, 11700]) {
      writeFileSync(control, JSON.stringify({ service: 'embedding', fitTarget }))
      await section.getByRole('button', { name: '重新检测', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => window.jiwei.localCompute.status().then((s) => s.maintenance)), { timeout: 90_000 })
        .toBeNull()
      const status = await page.evaluate(() => window.jiwei.localCompute.status())
      partialAttempts.push({ fitTarget, status: status.services.embedding })
      const { offloadedLayers: used, totalLayers: total } = status.services.embedding
      if (used && total && used < total) {
        partial = await liveEmbeddings(
          live
            .launches()
            .filter((x) => x.service === 'embedding')
            .at(-1)!,
          texts
        )
        await expect(section.getByTestId('local-compute-embedding')).toContainText(`${used}/${total}`)
        break
      }
    }
    save('partial-attempts', partialAttempts)
    expect(partial).not.toBeNull()
    const partialCosines = gpu.map((x, i) => cosine(x, partial![i]))
    expect(Math.min(...partialCosines)).toBeGreaterThan(0.999)
    if (evidence) await page.screenshot({ path: join(evidence, 'real-partial.png') })
    writeFileSync(control, JSON.stringify({ badDevice: true }))
    await section.getByRole('button', { name: '重新检测', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => window.jiwei.localCompute.status().then((s) => s.maintenance)), { timeout: 90_000 })
      .toBeNull()
    const fallback = await page.evaluate(() => window.jiwei.localCompute.status())
    expect(fallback.services.embedding.backend).toBe('cpu')
    expect(fallback.services.recognition.backend).toBe('cpu')
    expect(Object.keys(JSON.parse(readFileSync(join(models, 'accel.json'), 'utf8')).health)).toEqual(
      expect.arrayContaining(['b11491:metal:embedding', 'b11491:metal:recognition'])
    )
    const fallbackVectors = await liveEmbeddings(
      live
        .launches()
        .filter((x) => x.service === 'embedding')
        .at(-1)!,
      texts
    )
    expect(cosine(gpu[0], fallbackVectors[0])).toBeGreaterThan(0.999)
    writeFileSync(control, '{}')
    await section.getByRole('button', { name: '重新检测', exact: true }).click()
    await expect(section.getByTestId('local-compute-embedding')).toContainText('全部在 GPU', { timeout: 90_000 })
    await expect(section.getByTestId('local-compute-recognition')).toContainText('全部在 GPU', { timeout: 90_000 })
    await expect
      .poll(() => page.evaluate(() => window.jiwei.knowledge.search('学习记录 长期记忆', { type: 'all' }, 5).then((h) => h.length)), {
        timeout: 30_000
      })
      .toBeGreaterThan(0)
    const hits = await page.evaluate(() => window.jiwei.knowledge.search('学习记录 长期记忆', { type: 'all' }, 5))
    expect(JSON.stringify(hits)).toContain('长期记忆')
    save('metal-cpu-fit-recovery', {
      directory,
      id,
      fullStatus,
      metalStatus,
      cpuStatus,
      cpuCosines,
      partialAttempts,
      partialCosines,
      fallback,
      segments,
      hits
    })
    await app.close()
    const restarted = await launchLocalComputeApp(directory, cache!)
    try {
      expect((await restarted.page.evaluate((id) => window.jiwei.segments.list(id), id)).map((x) => x.text)).toEqual(
        segments.map((x) => x.text)
      )
      expect(await restarted.page.evaluate(() => window.jiwei.settings.get().then((s) => s.ai.localCompute))).toBe('auto')
    } finally {
      await restarted.app.close()
    }
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('real accurate OCR install and concurrent embedding stay healthy on the 16GB Mac', async () => {
  test.skip(
    !cache || process.platform !== 'darwin' || process.arch !== 'arm64',
    'Requires an explicitly isolated real-model cache on Apple silicon'
  )
  test.setTimeout(1_800_000)
  const directory = process.env.JIWEI_COMPUTE_4B_DIRECTORY ?? mkdtempSync(join(tmpdir(), 'jiwei-compute-4b-'))
  const live = await launchLocalComputeApp(directory, cache!)
  save('4b-run', { directory, models: live.models })
  const samples: unknown[] = []
  const sample = () => {
    const pids = live
      .launches()
      .map((x) => x.pid)
      .filter(Boolean)
    try {
      samples.push({
        at: Date.now(),
        processes: execFileSync('ps', ['-o', 'pid=,rss=,%cpu=,command=', '-p', pids.join(',')], { encoding: 'utf8' })
      })
    } catch {
      /* A model process may have just exited; the next sample and statuses cover it. */
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await live.page.evaluate(async () => {
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: {
          ...s.ai,
          localCompute: 'auto',
          embedding: { mode: 'local', providerId: null, model: null },
          recognition: { mode: 'local', providerId: null, model: null, auto: false, figures: true, localModel: 'accurate' }
        },
        retrieval: { ...s.retrieval, autoUpgrade: false }
      })
      await window.jiwei.embedding.installLocal()
    })
    await live.page.evaluate(() => window.jiwei.recognition.install())
    await expect
      .poll(
        async () => {
          const status = await live.page.evaluate(() => window.jiwei.recognition.status())
          if (status.state === 'error') throw new Error(status.message ?? 'Accurate OCR installation failed')
          return status.state
        },
        { timeout: 1_500_000, intervals: [1000] }
      )
      .toBe('ready')
    expect((await live.page.evaluate(() => window.jiwei.recognition.status())).model).toBe('LightOnOCR-3-4B')
    const file = join(directory, '4B并发识别.pdf')
    writeFileSync(
      file,
      makeImagePdf([
        { jpeg: scanImage(['积微并发模型验证', '学习记录支持长期记忆', '识别过程中向量检索继续工作']), w: 1240, h: 1754, text: [] }
      ])
    )
    const imported = await live.page.evaluate((path) => window.jiwei.sources.importPaths([path]), file)
    const id = imported.imported[0].id
    await waitForParsedSource(live.page, id)
    await expect
      .poll(() => live.page.evaluate((id) => window.jiwei.recognition.source(id).then((s) => s.total), id), { timeout: 30_000 })
      .toBeGreaterThan(0)
    await live.page.evaluate((id) => window.jiwei.recognition.start(id), id)
    timer = setInterval(sample, 1000)
    const embedding = live
      .launches()
      .filter((x) => x.service === 'embedding')
      .at(-1)!
    let calls = 0
    const until = Date.now() + 180_000
    while (Date.now() < until) {
      const vectors = await liveEmbeddings(embedding, ['同机同时运行向量和四十亿参数识别模型的合成测试。'])
      expect(vectors[0].length).toBe(768)
      calls++
      const current = await live.page.evaluate((id) => window.jiwei.recognition.source(id), id)
      if (current.done === 1 && !current.running) break
      if (current.failed) throw new Error('Real 4B OCR page failed; inspect the persisted job and application log')
      await new Promise((r) => setTimeout(r, 250))
    }
    expect((await live.page.evaluate((id) => window.jiwei.recognition.source(id), id)).done).toBe(1)
    expect(calls).toBeGreaterThan(1)
    const status = await live.page.evaluate(() => window.jiwei.localCompute.status())
    expect(status.services.embedding.state).toBe('running')
    expect(status.services.recognition.state).toBe('running')
    const segments = await live.page.evaluate((id) => window.jiwei.segments.list(id), id)
    expect(segments.map((x) => x.text).join('')).toContain('长期记忆')
    const section = await openComputeSettings(live.page)
    await expect(section.getByTestId('local-compute-recognition')).toContainText('GPU')
    if (evidence) await live.page.screenshot({ path: join(evidence, 'real-concurrent-4b.png') })
    save('concurrent-4b', { directory, calls, status, segments, samples, memory: execFileSync('vm_stat', { encoding: 'utf8' }) })
  } finally {
    if (timer) clearInterval(timer)
    save('concurrent-4b-memory', samples)
    await live.app.close()
  }
})

test('real speech workers preserve baseline text through import, persistence and responsive renderer IPC', async () => {
  const fixture = process.env.JIWEI_COMPUTE_SPEECH_VIDEO,
    baselineWorker = process.env.JIWEI_COMPUTE_BASELINE_WORKER
  test.skip(!cache || !fixture || !baselineWorker, 'Requires isolated native speech models, a synthetic video and a baseline worker')
  test.setTimeout(180_000)
  const runs: { version: string; texts: string[]; wallMs: number; metrics: unknown[]; renderer: unknown }[] = []
  for (const version of ['baseline', 'current']) {
    const directory = mkdtempSync(join(tmpdir(), `jiwei-compute-speech-${version}-`))
    const live = await launchLocalComputeApp(directory, cache!, version === 'baseline' ? resolve(baselineWorker!) : undefined)
    const metrics: unknown[] = []
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      await live.page.evaluate(async () => {
        const s = await window.jiwei.settings.get()
        await window.jiwei.settings.set({
          ai: {
            ...s.ai,
            embedding: { mode: 'cloud', providerId: null, model: null },
            recognition: { mode: 'off', providerId: null, model: null, auto: false, figures: false },
            transcription: { mode: 'cloud', providerId: null, model: null }
          },
          retrieval: { ...s.retrieval, autoUpgrade: false }
        })
      })
      const imported = await live.page.evaluate((path) => window.jiwei.sources.importPaths([path]), fixture!)
      const id = imported.imported[0].id
      await live.page.evaluate(async () => {
        const s = await window.jiwei.settings.get()
        await window.jiwei.settings.set({ ai: { ...s.ai, transcription: { mode: 'local', providerId: null, model: null } } })
      })
      const renderer = live.page.evaluate(
        () =>
          new Promise<{ intervalGaps: number[]; ipcMs: number[] }>((resolve) => {
            const intervalGaps: number[] = [],
              ipcMs: number[] = []
            let previous = performance.now(),
              busy = false
            const timer = setInterval(() => {
              const now = performance.now()
              intervalGaps.push(now - previous)
              previous = now
              if (!busy) {
                busy = true
                void window.jiwei.settings
                  .get()
                  .then(() => ipcMs.push(performance.now() - now))
                  .finally(() => {
                    busy = false
                  })
              }
            }, 50)
            const stop = window.jiweiEvents.on('jobs:changed', () => {
              void window.jiwei.jobs.list().then((jobs) => {
                if (jobs.some((job) => job.kind === 'source.transcribe' && job.status === 'done')) {
                  clearInterval(timer)
                  stop()
                  resolve({ intervalGaps, ipcMs })
                }
              })
            })
          })
      )
      timer = setInterval(() => {
        void live.app.evaluate(({ app }) => app.getAppMetrics()).then((value) => metrics.push({ at: Date.now(), value }))
      }, 250)
      const start = Date.now()
      await live.page.evaluate((id) => window.jiwei.asr.transcribe(id), id)
      await expect
        .poll(
          async () => {
            const job = (await live.page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.key === `transcribe:${id}`)
            if (job?.status === 'failed') throw new Error(job.error ?? 'Native speech worker failed')
            return job?.status
          },
          { timeout: 90_000 }
        )
        .toBe('done')
      const wallMs = Date.now() - start
      const segments = await live.page.evaluate((id) => window.jiwei.segments.list(id), id)
      const texts = segments.filter((s) => s.kind === 'transcript').map((s) => s.text)
      expect(texts.length).toBeGreaterThan(0)
      const responsiveness = await renderer
      expect(responsiveness.ipcMs.length).toBeGreaterThan(5)
      runs.push({ version, texts, wallMs, metrics, renderer: responsiveness })
      save(`speech-product-${version}`, { directory, id, version, segments, wallMs, metrics, renderer: responsiveness })
    } finally {
      if (timer) clearInterval(timer)
      await live.app.close()
    }
  }
  expect(runs[1].texts).toEqual(runs[0].texts)
  save('speech-product-comparison', {
    runs,
    note: 'Existing thread budgets retained; a single controlled comparison does not establish a performance improvement.'
  })
})
