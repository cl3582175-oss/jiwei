import { _electron as electron } from '@playwright/test'
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync, constants } from 'node:fs'
import { join, resolve } from 'node:path'

/** 隔离发生在应用模块加载之前；真实 OCR 只复制显式指定的模型和运行时。 */
export async function launchScannedPdfApp(directory: string, ocrCache?: string) {
  const repo = resolve('.')
  const modelData = join(directory, 'model-appdata')
  mkdirSync(modelData, { recursive: true })
  if (ocrCache) {
    const target = join(modelData, 'jiwei-models', 'ocr')
    mkdirSync(target, { recursive: true })
    for (const name of ['LightOnOCR-3-0.8B.Q8_0.gguf', 'LightOnOCR-3-0.8B.mmproj-q8_0.gguf']) {
      const path = join(ocrCache, 'ocr', name)
      if (!existsSync(path)) throw new Error(`Missing explicitly selected OCR model: ${name}`)
      copyFileSync(path, join(target, name), constants.COPYFILE_FICLONE)
    }
    cpSync(join(ocrCache, 'llama-b11491'), join(modelData, 'jiwei-models', 'llama-b11491'), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE
    })
  }
  const bootstrap = join(directory, 'scanned-pdf-bootstrap.cjs')
  writeFileSync(
    bootstrap,
    [
      "const {app}=require('electron')",
      `app.setAppPath(${JSON.stringify(repo)})`,
      `app.setName(require(${JSON.stringify(join(repo, 'package.json'))}).productName)`,
      `app.setPath('userData',${JSON.stringify(directory)})`,
      `app.setPath('appData',${JSON.stringify(modelData)})`,
      `app.setAppLogsPath(${JSON.stringify(join(directory, 'logs'))})`,
      `require(${JSON.stringify(join(repo, 'out/main/index.js'))})`
    ].join('\n')
  )
  const app = await electron.launch({
    args: [bootstrap, '--use-mock-keychain', `--user-data-dir=${directory}`],
    env: {
      ...process.env,
      JIWEI_TEST_MODEL_CACHE_ROOT: modelData,
      ELECTRON_RENDERER_URL: '',
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_MEMORY_DELAY_MS: '3600000',
      JIWEI_OCR_IDLE_MS: '15000'
    }
  })
  const isolation = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), appData: app.getPath('appData') }))
  if (isolation.userData !== directory || isolation.appData !== modelData) {
    await app.close()
    throw new Error('OCR test isolation mismatch')
  }
  const page = await app.firstWindow()
  await page.waitForSelector('nav')
  return { app, page }
}
