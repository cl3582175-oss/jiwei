import { defineConfig, _electron } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import base from './playwright.rag.config'

// 运行既有用例时也先隔离全局模型目录；不复制共享 PID，避免影响并行桌面应用。
const launch = _electron.launch.bind(_electron)
_electron.launch = async (options) => {
  const args = options?.args ?? []
  const argument = args.find((a) => a.startsWith('--user-data-dir='))
  if (args[0] !== '.' || !argument) return launch(options)
  const directory = argument.slice('--user-data-dir='.length)
  const repo = resolve('.')
  const appData = join(directory, 'model-appdata')
  mkdirSync(appData, { recursive: true })
  const bootstrap = join(directory, 'isolated-bootstrap.cjs')
  writeFileSync(
    bootstrap,
    [
      "const { app } = require('electron')",
      `app.setAppPath(${JSON.stringify(repo)})`,
      `const metadata = require(${JSON.stringify(join(repo, 'package.json'))})`,
      'app.setName(metadata.productName || metadata.name)',
      `app.setPath('userData', ${JSON.stringify(directory)})`,
      `app.setPath('appData', ${JSON.stringify(appData)})`,
      `app.setAppLogsPath(${JSON.stringify(join(directory, 'logs'))})`,
      `require(${JSON.stringify(join(repo, 'out/main/index.js'))})`
    ].join('\n')
  )
  return launch({ ...options, args: [bootstrap, ...args.slice(1)] })
}
export default defineConfig(base)
