/* global Buffer, process, fetch, AbortSignal */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const COMMIT = '072bbed282316a23651aa7068c7173aa7898cf80'
export const SOURCE = `https://raw.githubusercontent.com/hermitdave/FrequencyWords/${COMMIT}/content/2018/en/en_50k.txt`
export const SOURCE_SHA256 = '5351ff405b1126ef555791dd4d9798a48e3e9a501a9fc481a9da957752cfb458'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'resources/wordfreq/en.json')
const sha = (data) => createHash('sha256').update(data).digest('hex')

// 构建允许离线使用已校验的紧凑表；缺失或被修改时重新下载固定源。
async function build() {
  const manifest = JSON.parse(await readFile(resolve(root, 'resources/wordfreq/source.json'), 'utf8'))
  if (!process.argv.includes('--force')) {
    const existing = await readFile(output).catch(() => null)
    if (existing && sha(existing) === manifest.outputSha256) return
  }
  const local = process.argv.indexOf('--source')
  const download = async () => {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`Word frequency download failed: HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  const raw = local >= 0 ? await readFile(process.argv[local + 1]) : await download()
  if (sha(raw) !== SOURCE_SHA256) throw new Error('Word frequency source sha256 mismatch')
  const words = Object.create(null)
  const lines = raw.toString('utf8').trim().split(/\r?\n/).slice(0, 50_000)
  if (lines.length !== 50_000) throw new Error('Expected 50,000 English word frequency entries')
  for (const [i, line] of lines.entries()) {
    const word = line.split(/\s+/)[0]
    if (!Object.hasOwn(words, word)) words[word] = i + 1
  }
  const compact = Buffer.from(JSON.stringify(words))
  if (manifest.outputSha256 && sha(compact) !== manifest.outputSha256) throw new Error('Converted frequency table sha256 mismatch')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(`${output}.tmp`, compact)
  await rename(`${output}.tmp`, output)
  process.stdout.write(`wordfreq: ${Object.keys(words).length} entries; sha256 ${sha(compact)}\n`)
}
await build()
