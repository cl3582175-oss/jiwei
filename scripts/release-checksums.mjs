/* global process */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function checksumArtifacts(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && /^Jiwei-.*\.(dmg|zip|exe|AppImage|deb)$/.test(entry.name)) files.push(path)
    }
  }
  await walk(root)
  if (!files.length) throw new Error('No installers found; refusing an empty release')
  const names = new Set()
  const checksums = []
  for (const file of files.sort()) {
    const name = basename(file)
    if ([...name].some((c) => c.charCodeAt(0) < 32) || names.has(name)) throw new Error('Invalid or duplicate installer name')
    names.add(name)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    checksums.push({ name, sha256: hash.digest('hex') })
  }
  return checksums
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const directory = resolve(process.argv[2] || 'release')
  const checksums = await checksumArtifacts(directory)
  await writeFile(join(directory, 'SHA256SUMS.txt'), checksums.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n')
  const introduction = `安装前请核对以下 SHA-256。默认免费签名：macOS 首次打开若提示 Apple 无法验证，请到「系统设置 → 隐私与安全性 → 仍要打开」；Windows SmartScreen 请选「更多信息 → 仍要运行」。请只安装官方来源文件。\n\nVerify SHA-256 before installing. With the free signing mode, macOS may require System Settings → Privacy & Security → Open Anyway; Windows SmartScreen may require More info → Run anyway.\n\n`
  await writeFile(
    join(directory, 'RELEASE_NOTES.md'),
    introduction + '## SHA-256\n\n' + checksums.map((f) => `- ${f.name}: \`${f.sha256}\``).join('\n') + '\n'
  )
}
