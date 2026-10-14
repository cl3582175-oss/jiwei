import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 在应用模块加载前隔离 appData；只修改构建产物，不给生产程序添加测试分支。 */
export default function controlledSetup(): void {
  const root = mkdtempSync(join(tmpdir(), 'jiwei-controlled-model-cache-'))
  process.env.JIWEI_TEST_MODEL_CACHE_ROOT = root
  process.env.JIWEI_VOICE_MODELS_APPDATA = root
  process.env.JIWEI_TEST_NETWORK = '1'
  const path = join(process.cwd(), 'out/main/index.js'),
    body = readFileSync(path, 'utf8')
  const marker = '// Jiwei controlled empty model cache\n'
  if (!body.startsWith(marker))
    writeFileSync(
      path,
      marker +
        `{ const runtime = require('electron'); if (process.env.JIWEI_TEST_MODEL_CACHE_ROOT) runtime.app.setPath('appData', process.env.JIWEI_TEST_MODEL_CACHE_ROOT); }\n` +
        body
    )
}
