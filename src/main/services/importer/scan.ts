import type { ImportScan } from '@shared/importer'
import { lstat, readdir, realpath, open } from 'fs/promises'
import { constants } from 'fs'
import { basename, dirname, extname, isAbsolute, join, relative, sep, posix } from 'path'
import { createHash } from 'crypto'
import { importMarkdown, decodeImportText, type ImportReference } from '../../lib/importMarkdown'
import { matchNote } from './obsidian'
import { cueBodies } from './cuePlan'
export interface ScannedFile {
  relative: string
  absolute: string
  hash: string
  size: number
}
export interface ScannedLibrary extends Omit<ImportScan, 'id' | 'status' | 'progress' | 'jobId'> {
  root: string
  rootHash: string
  files: ScannedFile[]
  attachmentFolder?: string
}
export interface ImportHistory {
  rootHash: string
  path: string
  hash: string
  noteId: string
}
const LIMIT = 5 * 1024 * 1024
const hash = (v: Uint8Array | string): string => createHash('sha256').update(v).digest('hex')
const hidden = (p: string): boolean => p.split('/').some((part) => part.startsWith('.'))
const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

async function safeBytes(root: string, path: string): Promise<Uint8Array> {
  if (!inside(root, path)) throw new Error('outside-root')
  const rel = relative(root, path)
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink')
  }
  const canonical = await realpath(path)
  if (canonical !== path || !inside(root, canonical)) throw new Error('symlink')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('not-file')
    if (stat.size > LIMIT) throw new Error('too-large')
    const buf = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < buf.length) {
      const { bytesRead } = await file.read(buf, offset, buf.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > stat.size || (await realpath(path)) !== canonical) throw new Error('changed')
    return buf.subarray(0, offset)
  } finally {
    await file.close()
  }
}

export async function readChecked(library: ScannedLibrary, file: ScannedFile): Promise<Uint8Array> {
  const bytes = await safeBytes(library.root, file.absolute)
  if (hash(bytes) !== file.hash) throw new Error('changed')
  return bytes
}

export function matchAttachment(target: string, from: string, library: ScannedLibrary): ScannedFile | null {
  try {
    target = decodeURIComponent(target)
  } catch {
    return null
  }
  target = target.replace(/\\/g, '/').normalize('NFC')
  if (isAbsolute(target) || /^[a-z]:/i.test(target)) return null
  const local = posix.normalize(posix.join(posix.dirname(from), target))
  if (local.startsWith('../')) return null
  const at = (p: string): ScannedFile | undefined => library.files.find((f) => f.relative.normalize('NFC') === p)
  const direct = at(local) ?? at(target) ?? (library.attachmentFolder ? at(posix.join(library.attachmentFolder, target)) : undefined)
  if (direct) return direct
  const matches = library.files.filter((f) => posix.basename(f.relative).normalize('NFC') === target)
  return matches.length === 1 ? matches[0] : null
}

export async function scanLibrary(
  paths: string[],
  history: ImportHistory[],
  progress: (n: number) => void,
  signal?: AbortSignal
): Promise<ScannedLibrary> {
  const selected: string[] = []
  for (const p of paths) {
    if ((await lstat(p)).isSymbolicLink()) throw new Error('symlink')
    selected.push(await realpath(p))
  }
  const firstStat = await lstat(selected[0])
  let root = firstStat.isDirectory() ? selected[0] : dirname(selected[0])
  while (!selected.every((p) => inside(root, p))) root = dirname(root)
  const r: ScannedLibrary = {
    root,
    rootHash: hash(root),
    label: basename(root),
    kind: 'markdown',
    entries: [],
    files: [],
    issues: [],
    stats: { notes: 0, attachments: 0, tags: 0, links: 0, tasks: 0 }
  }
  if (firstStat.isDirectory()) {
    try {
      const obs = await lstat(join(root, '.obsidian'))
      if (obs.isDirectory() && !obs.isSymbolicLink()) {
        r.kind = 'obsidian'
        try {
          const props = JSON.parse(new TextDecoder().decode(await safeBytes(root, join(root, '.obsidian/app.json')))) as {
            attachmentFolderPath?: string
          }
          if (
            props.attachmentFolderPath &&
            !props.attachmentFolderPath.split('/').includes('..') &&
            !isAbsolute(props.attachmentFolderPath)
          )
            r.attachmentFolder = props.attachmentFolderPath
        } catch {
          /* fall back to unambiguous filename matching */
        }
      }
    } catch {
      /* plain Markdown folder */
    }
  }
  const candidates: string[] = []
  let total = 0,
    count = 0
  const visit = async (p: string): Promise<void> => {
    signal?.throwIfAborted()
    const key = relative(root, p).split(sep).join('/')
    if (hidden(key)) return
    const s = await lstat(p)
    if (s.isSymbolicLink()) {
      r.issues.push({ path: key, code: 'symlink' })
      return
    }
    if (s.isDirectory()) {
      const children = await readdir(p)
      for (const name of children.sort()) await visit(join(p, name))
      return
    }
    if (!s.isFile()) return
    if (++count > 50000 || (total += s.size) > 2 * 1024 ** 3) throw new Error('library-limit')
    if (s.size > LIMIT) {
      r.issues.push({ path: key, code: 'too-large' })
      return
    }
    if (/\.(canvas|excalidraw)$/i.test(p)) {
      r.issues.push({ path: key, code: 'unsupported' })
      return
    }
    candidates.push(p)
    if (count % 100 === 0) {
      progress(Math.min(0.2, count / 50000))
      await new Promise<void>((done) => setImmediate(done))
    }
  }
  for (const p of selected) await visit(p)
  const parsed = new Map<string, ImportReference[]>()
  for (const [index, p] of [...new Set(candidates)].sort().entries()) {
    signal?.throwIfAborted()
    const key = relative(root, p).split(sep).join('/')
    try {
      const bytes = await safeBytes(root, p),
        file = { absolute: p, relative: key, hash: hash(bytes), size: bytes.byteLength }
      if (!/\.(md|markdown|txt)$/i.test(extname(p))) {
        r.files.push(file)
        continue
      }
      if (r.entries.length >= 5000) {
        if (!r.issues.some((i) => i.code === 'note-limit')) r.issues.push({ path: '', code: 'note-limit' })
        continue
      }
      const decoded = decodeImportText(bytes),
        converted = importMarkdown(decoded.text, key)
      if (decoded.encoding === 'GBK') r.issues.push({ path: key, code: 'encoding' })
      for (const code of converted.issues) r.issues.push({ path: key, code: code as 'invalid-frontmatter' })
      if (converted.ignored.length) r.issues.push({ path: key, code: 'ignored', count: converted.ignored.length })
      const prior = history.filter((h) => h.rootHash === r.rootHash && h.path === key).at(-1)
      const cues = cueBodies(converted.doc)
      r.entries.push({
        path: key,
        title: converted.title,
        hash: file.hash,
        tags: converted.tags,
        aliases: converted.aliases,
        rows: converted.rows,
        tasks: converted.tasks,
        cueRows: cues.length,
        cueChars: cues.reduce((sum, c) => sum + c.body.length, 0),
        status: !prior ? 'new' : prior.hash === file.hash ? 'unchanged' : 'changed',
        ...(prior ? { previousNoteId: prior.noteId } : {})
      })
      r.files.push(file)
      parsed.set(key, converted.refs)
    } catch (e) {
      r.issues.push({ path: key, code: e instanceof Error && e.message === 'symlink' ? 'symlink' : 'unreadable' })
    }
    progress(0.2 + (0.8 * (index + 1)) / candidates.length)
    await new Promise<void>((done) => setImmediate(done))
  }
  const assets = new Set<string>()
  for (const [key, refs] of parsed) {
    let broken = 0
    for (const ref of refs) {
      if (ref.kind === 'note') {
        r.stats.links++
        if (!matchNote(ref.target, key, r.entries, ref.wiki)) broken++
      } else {
        const file = matchAttachment(ref.target, key, r)
        if (file) assets.add(file.relative)
        else broken++
      }
    }
    if (broken) r.issues.push({ path: key, code: 'broken-link', count: broken })
  }
  r.stats.notes = r.entries.length
  r.stats.attachments = assets.size
  r.stats.tags = new Set(r.entries.flatMap((e) => e.tags)).size
  r.stats.tasks = r.entries.reduce((n, e) => n + e.tasks, 0)
  progress(1)
  return r
}
