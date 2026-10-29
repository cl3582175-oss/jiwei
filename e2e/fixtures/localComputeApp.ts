import { _electron as electron } from '@playwright/test'
import { appendFileSync, constants, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ComputeLaunch {
  service: 'embedding' | 'recognition'
  pid: number
  args: string[]
  log: string
}

/** Only public model files are cloned. Paths and spawn instrumentation precede application imports. */
export async function launchLocalComputeApp(directory: string, cache: string, workerEntry?: string) {
  const repo = resolve('.'),
    modelData = join(directory, 'model-appdata'),
    models = join(modelData, 'jiwei-models')
  mkdirSync(models, { recursive: true })
  for (const name of ['llama-b11491', 'embeddinggemma-2-Q8_0.gguf', 'ocr', 'asr', 'sherpa-onnx-1.13.8', 'ffmpeg', 'tts']) {
    const source = join(cache, name),
      target = join(models, name)
    if (existsSync(source) && !existsSync(target))
      cpSync(source, target, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        verbatimSymlinks: true,
        filter: (path) => !path.split('/').at(-1)?.startsWith('.lease-')
      })
  }
  const control = join(directory, 'spawn-control.json'),
    launches = join(directory, 'launches.jsonl')
  if (!existsSync(control)) writeFileSync(control, '{}')
  const bootstrap = join(directory, 'compute-bootstrap.cjs')
  writeFileSync(
    bootstrap,
    [
      "const {app}=require('electron'),fs=require('fs'),cp=require('child_process'),path=require('path')",
      `app.setAppPath(${JSON.stringify(repo)})`,
      `app.setName(require(${JSON.stringify(join(repo, 'package.json'))}).productName)`,
      `app.setPath('userData',${JSON.stringify(directory)})`,
      `app.setPath('appData',${JSON.stringify(modelData)})`,
      `app.setAppLogsPath(${JSON.stringify(join(directory, 'logs'))})`,
      ...(workerEntry
        ? [
            "const utility=require('electron').utilityProcess,originalFork=utility.fork",
            `utility.fork=function(entry,args,options){return originalFork.call(this,path.basename(entry)==='worker.js'?${JSON.stringify(workerEntry)}:entry,args,options)}`
          ]
        : []),
      'const originalSpawn=cp.spawn',
      'let sequence=0',
      'cp.spawn=function(binary,args,options){',
      '  if(!/llama-server(?:\\.exe)?$/.test(String(binary))) return originalSpawn.call(this,binary,args,options)',
      '  args=[...args]',
      `  const control=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'))`,
      "  const service=args.includes('--embedding')?'embedding':'recognition'",
      "  if(args[args.indexOf('-ngl')+1]==='auto' && (!control.service || control.service===service)){",
      "    if(control.fitTarget) args[args.indexOf('--fit-target')+1]=String(control.fitTarget)",
      "    if(control.badDevice) args.push('--device','GPU_ACCEPTANCE_DEVICE_DOES_NOT_EXIST')",
      '  }',
      '  const child=originalSpawn.call(this,binary,args,options)',
      `  const log=path.join(${JSON.stringify(directory)},'llama-'+(++sequence)+'-'+service+'-'+child.pid+'.log')`,
      `  fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({service,pid:child.pid,args,log})+'\\n')`,
      "  child.stderr?.on('data',data=>fs.appendFileSync(log,data))",
      '  return child',
      '}',
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
      JIWEI_OCR_IDLE_MS: '120000'
    }
  })
  for (const stream of [app.process().stdout, app.process().stderr])
    stream?.on('data', (data) => appendFileSync(join(directory, 'application.log'), data))
  const paths = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), appData: app.getPath('appData') }))
  if (paths.userData !== directory || paths.appData !== modelData) {
    await app.close()
    throw new Error('Compute isolation mismatch')
  }
  const page = await app.firstWindow()
  await page.waitForSelector('nav')
  return {
    app,
    page,
    models,
    control,
    launches: (): ComputeLaunch[] =>
      existsSync(launches)
        ? readFileSync(launches, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
  }
}

/** Synthetic inputs go to the same live server the application started. */
export async function liveEmbeddings(launch: ComputeLaunch, input: string[]): Promise<number[][]> {
  const port = launch.args[launch.args.indexOf('--port') + 1]
  const result = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input })
  })
  if (!result.ok) throw new Error(`Live embeddings failed: ${result.status} ${await result.text()}`)
  const body = (await result.json()) as { data: { index: number; embedding: number[] }[] }
  return body.data.sort((a, b) => a.index - b.index).map((x) => x.embedding)
}

export function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, x, i) => sum + x * b[i], 0)
  return dot / Math.sqrt(a.reduce((s, x) => s + x * x, 0) * b.reduce((s, x) => s + x * x, 0))
}
