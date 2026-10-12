/* global process */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
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

/** CHANGELOG.md 中该版本的一节（不含标题）；应用内“更新说明”显示的就是 Release 正文 */
export function changelogSection(text, version) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const directory = resolve(process.argv[2] || 'release')
  const checksums = await checksumArtifacts(directory)
  await writeFile(join(directory, 'SHA256SUMS.txt'), checksums.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n')
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  const changes = changelogSection(await readFile('CHANGELOG.md', 'utf8').catch(() => ''), version)
  const install = `## 安装 / Install\n\n青风铃 出品。积微暂未购买付费签名证书：macOS 首次打开若提示 Apple 无法验证，请到「系统设置 → 隐私与安全性」点「仍要打开」；Windows 看到 SmartScreen 时选「更多信息 → 仍要运行」。请只安装下面 SHA-256 一致的文件。\n\nmacOS may ask you to allow the app once in System Settings → Privacy & Security → Open Anyway; on Windows choose More info → Run anyway. Install only files whose SHA-256 matches the list below.\n\n`
  await writeFile(
    join(directory, 'RELEASE_NOTES.md'),
    (changes ? changes + '\n\n' : '') + install + '## SHA-256\n\n' + checksums.map((f) => `- ${f.name}: \`${f.sha256}\``).join('\n') + '\n'
  )
}
