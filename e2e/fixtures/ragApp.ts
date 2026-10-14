import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isolateEmbeddingCache } from './embeddingCache'

/** 重开评测库之前先隔离 appData，避免启动索引误用用户模型进程的 PID。 */
export async function launchRagApp(directory: string, providers = ''): Promise<ElectronApplication> {
  const repo = resolve('.')
  const modelData = join(directory, 'model-appdata')
  const sharedCache =
    process.env.JIWEI_TEST_MODEL_CACHE_ROOT ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA!
        : join(homedir(), '.config'))
  mkdirSync(modelData, { recursive: true })
  // 只复制模型文件，不复制共享 PID、设置或用户库。
  if (process.env.JIWEI_OCR === '1') {
    const target = join(modelData, 'jiwei-models', 'ocr')
    mkdirSync(target, { recursive: true })
    for (const name of ['LightOnOCR-3-0.8B.Q8_0.gguf', 'LightOnOCR-3-0.8B.mmproj-q8_0.gguf']) {
      const source = join(sharedCache, 'jiwei-models', 'ocr', name)
      if (existsSync(source)) cpSync(source, join(target, name))
    }
  }
  const bootstrap = join(directory, 'rag-bootstrap.cjs')
  writeFileSync(
    bootstrap,
    [
      "const { app } = require('electron')",
      `app.setAppPath(${JSON.stringify(repo)})`,
      `const metadata = require(${JSON.stringify(join(repo, 'package.json'))})`,
      'app.setName(metadata.productName || metadata.name)',
      `app.setPath('userData', ${JSON.stringify(directory)})`,
      `app.setPath('appData', ${JSON.stringify(modelData)})`,
      `app.setAppLogsPath(${JSON.stringify(join(directory, 'logs'))})`,
      `require(${JSON.stringify(join(repo, 'out/main/index.js'))})`
    ].join('\n')
  )
  const application = await electron.launch({
    args: [bootstrap, `--user-data-dir=${directory}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: providers,
      JIWEI_TEST_MODEL_CACHE_ROOT: sharedCache
    }
  })
  await isolateEmbeddingCache(application)
  return application
}
