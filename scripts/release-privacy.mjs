/* global process */
import { readdir } from 'node:fs/promises'
import { join, resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import asar from '@electron/asar'

const forbiddenEntry =
  /^(?:\.agents|\.specify|\.claude|\.codex|\.superpowers|\.github|docs|src|e2e|test-results|playwright-report)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/
const contentRules = [
  ['personal-home-path', /\/(?:Users|home)\/(?!runner\/|Shared\/)[^/\s"']+\/(?:\.codex|Projects|Documents|Desktop)\//],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{25,}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{128,}/]
]

/** Inspect the build's own unpacked application archive; never download an installer. */
export function inspectArchive(archive) {
  const entries = asar.listPackage(archive).map((name) => name.replaceAll('\\', '/').replace(/^\//, ''))
  const findings = entries
    .filter((name) => forbiddenEntry.test(name) && !asar.statFile(archive, normalize(name)).files)
    .map((name) => ({ rule: 'private-development-file', file: name }))
  for (const required of ['package.json', 'out/main/index.js', 'out/renderer/index.html']) {
    if (!entries.includes(required)) throw new Error(`Incomplete application archive: missing ${required}`)
  }
  const applicationFiles = entries.filter(
    (name) => name === 'package.json' || (name.startsWith('out/') && /\.(?:[cm]?js|json|html|css|map)$/.test(name))
  )
  for (const name of applicationFiles) {
    const text = asar.extractFile(archive, normalize(name)).toString('utf8')
    for (const [rule, pattern] of contentRules) if (pattern.test(text)) findings.push({ rule, file: name })
  }
  // Report only rule names and relative entries, never the matched credential or text.
  if (findings.length) throw new Error(`Release privacy check failed: ${JSON.stringify(findings)}`)
  return { entries: entries.length, applicationFilesScanned: applicationFiles.length }
}

export async function inspectReleaseDirectory(directory, minimumArchives = 1) {
  const archives = []
  async function walk(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === 'app.asar') archives.push(path)
    }
  }
  await walk(directory)
  if (archives.length < minimumArchives)
    throw new Error(`Expected at least ${minimumArchives} application archives, found ${archives.length}`)
  return archives.map(inspectArchive)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const results = await inspectReleaseDirectory(resolve(process.argv[2] || 'release'), process.env.RUNNER_OS === 'macOS' ? 2 : 1)
  for (const [index, result] of results.entries()) process.stdout.write(`Application archive ${index + 1}: ${JSON.stringify(result)}\n`)
}
