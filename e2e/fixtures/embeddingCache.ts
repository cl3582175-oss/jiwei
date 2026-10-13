import type { ElectronApplication } from '@playwright/test'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 复用只读模型文件，测试的 PID、下载与运行时状态均写入临时 user-data-dir。 */
export async function isolateEmbeddingCache(application: ElectronApplication): Promise<void> {
  const paths = await application.evaluate(({ app }) => ({ source: app.getPath('appData'), data: app.getPath('userData') }))
  const isolated = join(paths.data, 'model-appdata')
  const target = join(isolated, 'jiwei-models')
  mkdirSync(target, { recursive: true })
  for (const name of ['embeddinggemma-2-Q8_0.gguf', 'llama-b11491']) {
    const source = join(paths.source, 'jiwei-models', name)
    if (existsSync(source)) cpSync(source, join(target, name), { recursive: true })
  }
  await application.evaluate(({ app }, isolated) => app.setPath('appData', isolated), isolated)
}
