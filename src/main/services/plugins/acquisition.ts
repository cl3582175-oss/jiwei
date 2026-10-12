import { mkdtemp, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { downloadBounded } from '../download'
import { emit } from '../../events'
import { PLUGIN_LIMITS, prepareRepositorySource } from './sources'
import { safeRelativePath } from '@shared/plugins'

export interface GithubSource {
  kind: 'github'
  repo: string
  ref?: string
  subdir?: string
  sha?: string
}
export type MarketSource = GithubSource | { kind: 'folder'; path: string } | { kind: 'url'; url: string }
export function githubSource(value: string): GithubSource {
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    safeRelativePath(value)
    if (value.split('/').some((p) => p === '.')) throw new Error('Invalid GitHub repository')
    return { kind: 'github', repo: value.replace(/\.git$/, '') }
  }
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash)
    throw new Error('Only GitHub repositories are supported / 仅支持 GitHub 仓库')
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent)
  if (parts.length < 2 || !parts.slice(0, 2).every((p) => /^[\w.-]+$/.test(p))) throw new Error('Invalid GitHub repository')
  safeRelativePath(parts.slice(0, 2).join('/'))
  if (parts.slice(0, 2).some((p) => p === '.')) throw new Error('Invalid GitHub repository')
  if (parts.length > 2 && (parts[2] !== 'tree' || !parts[3])) throw new Error('Invalid GitHub tree URL')
  return {
    kind: 'github',
    repo: parts
      .slice(0, 2)
      .join('/')
      .replace(/\.git$/, ''),
    ...(parts[3] ? { ref: parts[3] } : {}),
    ...(parts.length > 4 ? { subdir: safeRelativePath(parts.slice(4).join('/')) } : {})
  }
}
export function sourceLink(source: MarketSource): string {
  return source.kind === 'github'
    ? `https://github.com/${source.repo}${source.ref ? `/tree/${encodeURIComponent(source.ref)}` : ''}${source.subdir ? `/${source.subdir}` : ''}`
    : source.kind === 'url'
      ? source.url
      : source.path
}
export function httpsUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Source requires HTTPS without credentials')
  return url.href
}
function endpoint(kind: 'RAW' | 'CODELOAD' | 'API', path: string): string {
  const fallback = { RAW: 'https://raw.githubusercontent.com', CODELOAD: 'https://codeload.github.com', API: 'https://api.github.com' }
  return `${(process.env[`JIWEI_GITHUB_${kind}`] || fallback[kind]).replace(/\/$/, '')}/${path}`
}
const encoded = (value: string) => value.split('/').map(encodeURIComponent).join('/')
export class AcquisitionBatch {
  rateLimited = false
  private cache = new Map<string, Promise<string>>()
  private downloadedBytes = 0
  private temp: Promise<string>
  constructor(
    readonly signal: AbortSignal,
    readonly id: string
  ) {
    this.temp = mkdtemp(join(tmpdir(), 'jiwei-plugin-download-'))
  }
  async file(url: string, maxBytes: number, headers?: Record<string, string>): Promise<string> {
    this.signal.throwIfAborted()
    const key = JSON.stringify([url, maxBytes, headers])
    let item = this.cache.get(key)
    if (!item) {
      const index = this.cache.size
      item = this.temp.then(async (root) => {
        const dest = join(root, `${index}.zip`)
        let previous = 0
        await downloadBounded({ url, dest, maxBytes, headers }, this.signal, (received, total) => {
          this.downloadedBytes += received - previous
          previous = received
          if (this.downloadedBytes > 250 * 1024 * 1024) throw new Error('Marketplace batch download limit exceeded')
          emit('plugins:progress', { id: this.id, phase: 'download', received, total })
        })
        return dest
      })
      this.cache.set(key, item)
    }
    return item
  }
  async text(url: string, headers?: Record<string, string>): Promise<string> {
    try {
      return await readFile(await this.file(url, PLUGIN_LIMITS.textBytes, headers), 'utf8')
    } catch (error) {
      if (error instanceof Error && /HTTP (403|429)/.test(error.message)) this.rateLimited = true
      throw error
    }
  }
  async refs(source: GithubSource): Promise<string[]> {
    if (source.sha || source.ref) return [source.sha ?? source.ref!]
    try {
      const data = JSON.parse(await this.text(endpoint('API', `repos/${source.repo}`)))
      if (typeof data.default_branch !== 'string' || !data.default_branch || data.default_branch.length > 256)
        throw new Error('Invalid default branch')
      return [data.default_branch]
    } catch {
      this.signal.throwIfAborted()
      return ['main', 'master']
    }
  }
  async sha(source: GithubSource, ref: string): Promise<string | undefined> {
    if (source.sha) {
      if (!/^[a-f0-9]{40}$/i.test(source.sha)) throw new Error('Invalid commit SHA')
      return source.sha
    }
    try {
      const text = (
        await this.text(endpoint('API', `repos/${source.repo}/commits/${encodeURIComponent(ref)}`), {
          Accept: 'application/vnd.github.sha'
        })
      ).trim()
      if (/^[a-f0-9]{40}$/i.test(text)) return text
    } catch {
      this.signal.throwIfAborted()
    }
    return undefined
  }
  async catalog(source: GithubSource): Promise<{ raw: unknown; source: GithubSource }> {
    for (const ref of await this.refs(source)) {
      try {
        const path = [source.repo, encodeURIComponent(ref), source.subdir ? encoded(source.subdir) : '', '.claude-plugin/marketplace.json']
          .filter(Boolean)
          .join('/')
        return { raw: JSON.parse(await this.text(endpoint('RAW', path))), source: { ...source, ref } }
      } catch {
        this.signal.throwIfAborted()
      }
    }
    throw new Error('无法连接 GitHub，可稍后重试或下载插件 zip 后从文件安装 / Cannot load GitHub marketplace')
  }
  async repository(source: GithubSource, selection?: string[], discovery = false) {
    for (const ref of await this.refs(source)) {
      try {
        const sha = await this.sha(source, ref)
        // 获取到 commit 后固定 zip 到同一 commit，版本与内容不因分支变化错配。
        const file = await this.file(
          endpoint('CODELOAD', `${source.repo}/zip/${encodeURIComponent(sha ?? ref)}`),
          PLUGIN_LIMITS.archiveBytes
        )
        const prepared = await prepareRepositorySource(file, source.subdir, this.signal, selection, discovery)
        return { prepared, sha, source: { ...source, ref } }
      } catch (error) {
        this.signal.throwIfAborted()
        if (source.ref || source.sha) throw error
      }
    }
    throw new Error('无法连接 GitHub，可稍后重试或下载插件 zip 后从文件安装 / Cannot acquire GitHub repository')
  }
  async cleanup(): Promise<void> {
    await rm(await this.temp, { recursive: true, force: true })
  }
}
