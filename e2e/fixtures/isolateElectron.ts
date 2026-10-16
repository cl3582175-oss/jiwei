import { _electron } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 必须在应用模块加载前隔离所有缓存；Electron 不保证执行 NODE_OPTIONS 的预加载。 */
export const isolatedElectron = {
  async launch(options: Parameters<typeof _electron.launch>[0] = {}) {
    const args = [...(options.args ?? [])]
    const directory = args.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
    if (!directory || args[0] !== '.') throw new Error('Expected a source launch with an explicit isolated userData directory')
    const repo = resolve('.')
    const modelData = options.env?.JIWEI_TEST_MODEL_CACHE_ROOT || join(directory, 'model-appdata')
    mkdirSync(directory, { recursive: true })
    mkdirSync(modelData, { recursive: true })
    const bootstrap = join(directory, 'isolated-bootstrap.cjs')
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
    args[0] = bootstrap
    const application = await _electron.launch({ ...options, args })
    const actual = await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), appData: app.getPath('appData') }))
    if (actual.userData !== directory || actual.appData !== modelData) {
      await application.close()
      throw new Error('Electron launch isolation mismatch')
    }
    return application
  }
}
