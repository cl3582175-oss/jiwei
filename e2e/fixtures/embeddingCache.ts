import type { ElectronApplication } from '@playwright/test'
import { constants, cpSync, createReadStream, existsSync, mkdirSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

interface InstallArtifact {
  file: string
  path: string
  size: number
  sha256: string
}

const installArtifacts: InstallArtifact[] = [
  {
    file: 'embeddinggemma-2-Q8_0.gguf',
    path: 'embeddinggemma-2-Q8_0.gguf',
    size: 309855456,
    sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135'
  },
  {
    file: 'llama-b11491-bin-macos-arm64.tar.gz',
    path: '.llama-downloads/llama-b11491-bin-macos-arm64.tar.gz',
    size: 12041314,
    sha256: '5dc61b413298db5e5c547c39b40d1148844eca23f247f8741444837a7cc3626d'
  }
]

/** Pre-launch macOS ARM artifact cache; never copy installed runtimes, leases or PID files. */
export async function prepareEmbeddingInstallCache(source: string, artifacts = installArtifacts): Promise<string> {
  const appData = await mkdtemp(join(tmpdir(), 'jiwei-browser-model-cache-'))
  try {
    for (const artifact of artifacts) {
      const from = join(source, artifact.file),
        to = join(appData, 'jiwei-models', artifact.path)
      if (!(await lstat(from)).isFile()) throw new Error(`Embedding fixture requires a regular file: ${artifact.file}`)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to, constants.COPYFILE_FICLONE)
      if ((await stat(to)).size !== artifact.size) throw new Error(`Embedding fixture size mismatch: ${artifact.file}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(to)) hash.update(chunk)
      if (hash.digest('hex') !== artifact.sha256) throw new Error(`Embedding fixture sha256 mismatch: ${artifact.file}`)
    }
    return appData
  } catch (error) {
    await rm(appData, { recursive: true, force: true })
    throw error
  }
}

/** 复用只读模型文件，测试的 PID、下载与运行时状态均写入临时 user-data-dir。 */
export async function isolateEmbeddingCache(application: ElectronApplication): Promise<void> {
  const paths = await application.evaluate(({ app }) => ({
    // 整组受控验证可在启动前隔离appData；只从原目录复制两项允许的模型缓存，不复制PID或用户库。
    source: process.env.JIWEI_TEST_MODEL_CACHE_ROOT ?? app.getPath('appData'),
    data: app.getPath('userData')
  }))
  const isolated = join(paths.data, 'model-appdata')
  const target = join(isolated, 'jiwei-models')
  mkdirSync(target, { recursive: true })
  for (const name of ['embeddinggemma-2-Q8_0.gguf', 'llama-b11491']) {
    const source = join(paths.source, 'jiwei-models', name)
    if (existsSync(source)) cpSync(source, join(target, name), { recursive: true })
  }
  await application.evaluate(({ app }, isolated) => app.setPath('appData', isolated), isolated)
}
