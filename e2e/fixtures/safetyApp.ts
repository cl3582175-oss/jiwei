import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, existsSync, symlinkSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

export interface SafetyApp {
  app: ElectronApplication
  page: Page
  userData: string
  modelRoot: string
  close: () => Promise<void>
}
export const ffmpeg = join(homedir(), 'Library/Application Support/jiwei-models/ffmpeg/ffmpeg')
export async function startSafetyApp(
  options: { userData?: string; vault?: string; env?: Record<string, string>; allModels?: boolean; modelsFrom?: string } = {}
): Promise<SafetyApp> {
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), 'jiwei-safety-')),
    modelRoot = mkdtempSync(join(tmpdir(), 'jiwei-safety-models-'))
  mkdirSync(userData, { recursive: true })
  mkdirSync(join(modelRoot, 'jiwei-models'))
  if (options.vault) writeFileSync(join(userData, 'jiwei-config.json'), JSON.stringify({ dataDir: options.vault }))
  const cache = join(homedir(), 'Library/Application Support/jiwei-models')
  for (const name of options.allModels ? ['ffmpeg', 'asr', 'sherpa-onnx-1.13.8', 'moss', 'voiceprint'] : ['ffmpeg'])
    if (existsSync(join(cache, name))) symlinkSync(join(cache, name), join(modelRoot, 'jiwei-models', name), 'dir')
  if (options.modelsFrom)
    for (const name of ['moss', 'voiceprint'])
      if (!existsSync(join(modelRoot, 'jiwei-models', name)) && existsSync(join(options.modelsFrom, 'jiwei-models', name)))
        symlinkSync(join(options.modelsFrom, 'jiwei-models', name), join(modelRoot, 'jiwei-models', name), 'dir')
  const app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', ...options.env }
    }),
    page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ app }, root) => app.setPath('appData', root), modelRoot)
  const size = (process.env.JIWEI_TEST_WINDOW ?? '1440x900').split('x').map(Number)
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), size)
  await expect
    .poll(() => page.evaluate(() => window.jiwei.backups.status().then((s) => s.progress.state)), { timeout: 30000 })
    .not.toBe('running')
  return { app, page, userData, modelRoot, close: () => app.close() }
}
export async function pickSave(env: SafetyApp, file: string): Promise<void> {
  await env.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog
  }, file)
}
export async function pickOpen(env: SafetyApp, file: string): Promise<void> {
  await env.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
  }, file)
}
export async function injectRecording(
  env: SafetyApp,
  opts: { audio?: string; seconds?: number; finish?: boolean } = {}
): Promise<{ id: string; sourceId: string | null }> {
  const file = opts.audio ?? join(env.userData, 'injected.webm'),
    seconds = opts.seconds ?? 3
  if (!opts.audio)
    execFileSync(ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=220:duration=${seconds}`,
      '-c:a',
      'libopus',
      '-y',
      file
    ])
  const r = await env.page.evaluate(() =>
    window.jiwei.recording.begin({ scene: 'thought', tracks: ['mic'], localOnly: true, participants: [], extraHotwords: '' })
  )
  await env.page.evaluate(
    ({ id, bytes, durationMs }) =>
      window.jiwei.recording.chunk({ id, track: 'mic', sequence: 0, startMs: 0, durationMs, bytes: new Uint8Array(bytes) }),
    { id: r.id, bytes: [...readFileSync(file)], durationMs: seconds * 1000 }
  )
  return opts.finish === false ? r : env.page.evaluate((id) => window.jiwei.recording.finish(id), r.id)
}
export async function enableEncryption(env: SafetyApp): Promise<string> {
  const code = await env.page.evaluate(() => window.jiwei.recording.prepareRecovery())
  await env.page.evaluate((group) => window.jiwei.recording.confirmRecovery(group), code.slice(-4))
  await expect.poll(() => env.page.evaluate(() => window.jiwei.recording.cryptoStatus().then((s) => s.progress.state))).not.toBe('running')
  return code
}
export async function settingsData(env: SafetyApp): Promise<void> {
  await env.page.getByRole('button', { name: /^设置/ }).click()
  await env.page.getByRole('dialog').getByRole('tab', { name: '数据', exact: true }).click()
  await env.page.getByTestId('backup-settings').scrollIntoViewIfNeeded()
}
