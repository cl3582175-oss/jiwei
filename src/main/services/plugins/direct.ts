import { dialog, type BrowserWindow } from 'electron'
import { randomBytes, createHash } from 'crypto'
import { basename, dirname, join } from 'path'
import { mkdir, lstat, readdir } from 'fs/promises'
import { parseMarketplace, type PluginDetection, type PluginInspectInput, type PluginOrigin } from '@shared/plugins'
import { AcquisitionBatch, githubSource, sourceLink, type MarketSource } from './acquisition'
import {
  REPOSITORY_LIMITS,
  inspectPluginFolder,
  preparePluginSource,
  safePluginPath,
  sourceType,
  type PreparedPluginSource
} from './sources'
import { readPluginText } from './components'
import { inspectAcquired, inspectPlugin, updatePlugin, cancelPluginPreview } from './install'
import { pluginMutation, pluginRoot } from './state'
import { addMarketSource } from './markets'

interface Operation {
  id: string
  owner: number
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  busy: boolean
  preview?: string
  detection?: {
    token: string
    prepared: PreparedPluginSource
    source?: MarketSource
    name: string
    origin: PluginOrigin
    skills?: string[]
    sha?: string
  }
}
const operations = new Map<string, Operation>()
export function beginAcquisition(owner: number): string {
  if ([...operations.values()].filter((x) => x.owner === owner).length >= 8) throw new Error('Too many pending plugin operations')
  const id = randomBytes(32).toString('hex')
  const timer = setTimeout(() => void cancelAcquisition(owner, id), 10 * 60_000)
  timer.unref()
  operations.set(id, { id, owner, controller: new AbortController(), timer, busy: false })
  return id
}
function operation(owner: number, id: string): Operation {
  const item = operations.get(id)
  if (!item || item.owner !== owner) throw new Error('Invalid acquisition operation')
  item.controller.signal.throwIfAborted()
  return item
}
export async function cancelAcquisition(owner: number, id: string): Promise<void> {
  const item = operations.get(id)
  if (!item || item.owner !== owner) return
  item.controller.abort()
  clearTimeout(item.timer)
  if (item.preview) await cancelPluginPreview(item.preview)
  if (!item.busy) {
    await item.detection?.prepared.cleanup()
    operations.delete(id)
  }
}
export async function cancelOwnerAcquisitions(owner: number): Promise<void> {
  for (const [id, item] of operations) if (item.owner === owner) await cancelAcquisition(owner, id)
}
async function run<T>(owner: number, id: string, fn: (item: Operation) => Promise<T>): Promise<T> {
  const item = operation(owner, id)
  if (item.busy) throw new Error('Acquisition already running')
  item.busy = true
  try {
    return await fn(item)
  } finally {
    item.busy = false
    if (item.controller.signal.aborted) {
      await item.detection?.prepared.cleanup()
      if (item.preview) await cancelPluginPreview(item.preview)
      operations.delete(id)
    }
  }
}
function localSourceName(value: string): string {
  const raw = basename(value).replace(/\.(zip|tgz|tar\.gz)$/i, '')
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) return raw.slice(0, 128)
  const slug =
    raw
      .normalize('NFKC')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'local-skills'
  return `${slug}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`
}
async function detectPrepared(
  item: Operation,
  prepared: PreparedPluginSource,
  origin: PluginOrigin,
  name: string,
  source?: MarketSource,
  sha?: string
): Promise<PluginDetection> {
  const files = await inspectPluginFolder(prepared.root, REPOSITORY_LIMITS)
  item.controller.signal.throwIfAborted()
  const token = randomBytes(32).toString('hex')
  if (files.includes('.claude-plugin/marketplace.json')) {
    const market = parseMarketplace(JSON.parse(await readPluginText(prepared.root, '.claude-plugin/marketplace.json')))
    item.detection = { token, prepared, source, name: market.name, origin }
    return { kind: 'market', token, name: market.name, owner: market.owner.name, count: market.plugins.length }
  }
  if (
    files.includes('.claude-plugin/plugin.json') ||
    (await lstat(join(prepared.root, 'skills')).then(
      (s) => s.isDirectory(),
      () => false
    )) ||
    files.includes('SKILL.md')
  ) {
    const preview = await inspectAcquired(
      {
        path: prepared.root,
        type: 'folder',
        progressId: item.id,
        origin,
        options: {
          sha,
          ...(!files.includes('.claude-plugin/plugin.json') ? { entry: { name: localSourceName(name), source: '.', strict: true } } : {})
        }
      },
      undefined,
      item.controller.signal
    )
    item.preview = preview.token
    return { kind: 'plugin', preview }
  }
  const skills = files.filter((p) => p.endsWith('/SKILL.md')).map((p) => dirname(p))
  if (!skills.length) throw new Error('No marketplace, plugin or Agent Skills found / 没有找到市场、插件或技能')
  name = localSourceName(name)
  item.detection = { token, prepared, source, name, origin, skills, sha }
  return { kind: 'skills', token, name, skills: skills.map((path) => ({ path, name: basename(path) })) }
}
export function detectGithub(owner: number, id: string, input: PluginInspectInput): Promise<PluginDetection> {
  return run(owner, id, async (item) => {
    if (item.detection || item.preview) throw new Error('Operation already has a result')
    if (input.kind === 'market') {
      const preview = await inspectPlugin(input, { signal: item.controller.signal, id })
      item.preview = preview.token
      return { kind: 'plugin', preview }
    }
    return pluginMutation(async () => {
      const batch = new AcquisitionBatch(item.controller.signal, id)
      let prepared: PreparedPluginSource | undefined
      try {
        const source = githubSource(input.url),
          result = await batch.repository(source, undefined, true)
        prepared = result.prepared
        const name = basename(source.subdir ?? source.repo)
        return await detectPrepared(
          item,
          prepared,
          { kind: 'github', market: 'local', locator: sourceLink(source) },
          name,
          source,
          result.sha
        )
      } finally {
        if (prepared && (item.detection as Operation['detection'])?.prepared !== prepared) await prepared.cleanup()
        await batch.cleanup()
      }
    })
  })
}
export function acquireUpdate(owner: number, id: string, pluginId: string) {
  return run(owner, id, async (item) => {
    if (item.detection || item.preview) throw new Error('Operation already has a result')
    const preview = await updatePlugin(pluginId, { signal: item.controller.signal, id })
    item.preview = preview.token
    return preview
  })
}
/** 路径只来自 main 原生选择器；自动化调用须经过受开关保护的 IPC。 */
export function detectPath(owner: number, id: string, path: string): Promise<PluginDetection> {
  return run(owner, id, (item) =>
    pluginMutation(async () => {
      if (item.detection || item.preview) throw new Error('Operation already has a result')
      const prepared = await preparePluginSource({ path, type: sourceType(path), repository: true })
      try {
        let subdir: string | undefined
        // GitHub 下载的 zip 带单层仓库包装目录；标准插件自己的 skills/ 不剥离。
        if (sourceType(path) !== 'folder') {
          const children = await readdir(prepared.root, { withFileTypes: true })
          if (
            children.length === 1 &&
            children[0].isDirectory() &&
            !['skills', 'commands', 'jiwei', '.claude-plugin'].includes(children[0].name)
          ) {
            const child = await safePluginPath(prepared.root, children[0].name)
            const nested = await readdir(child, { withFileTypes: true })
            // 单个技能目录本身不是仓库包装；保留技能选择层级。
            const wrapped =
              nested.some((entry) => ['.claude-plugin', 'skills'].includes(entry.name)) ||
              (
                await Promise.all(
                  nested
                    .filter((entry) => entry.isDirectory())
                    .map((entry) =>
                      lstat(join(child, entry.name, 'SKILL.md')).then(
                        (st) => st.isFile(),
                        () => false
                      )
                    )
                )
              ).some(Boolean)
            if (wrapped) {
              subdir = children[0].name
              prepared.root = child
            }
          }
        }
        const name = basename(path)
        return await detectPrepared(
          item,
          prepared,
          { kind: 'local', market: 'local', locator: path, ...(subdir ? { subdir } : {}) },
          name,
          sourceType(path) === 'folder' ? { kind: 'folder', path } : undefined
        )
      } finally {
        if ((item.detection as Operation['detection'])?.prepared !== prepared) await prepared.cleanup()
      }
    })
  )
}
export async function detectFile(owner: number, id: string, win: BrowserWindow | null): Promise<PluginDetection | null> {
  operation(owner, id)
  const options = {
    properties: ['openFile', 'openDirectory'] as ('openFile' | 'openDirectory')[],
    filters: [{ name: 'Plugin', extensions: ['zip', 'gz'] }]
  }
  const selected = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (selected.canceled || !selected.filePaths[0]) return null
  return detectPath(owner, id, selected.filePaths[0])
}
export function selectDetectedSkills(owner: number, id: string, token: string, paths: string[]): Promise<PluginDetection> {
  return run(owner, id, (item) =>
    pluginMutation(async () => {
      const detected = item.detection
      if (
        !detected?.skills ||
        detected.token !== token ||
        !paths.length ||
        new Set(paths).size !== paths.length ||
        paths.some((p) => !detected.skills!.includes(p))
      )
        throw new Error('Invalid skill selection')
      const selected = await preparePluginSource({ path: detected.prepared.root, type: 'folder', selection: paths })
      try {
        // 选择后的包只含勾选目录；源阶段应用合计预算。
        const preview = await inspectAcquired(
          {
            path: selected.root,
            type: 'folder',
            progressId: item.id,
            origin: { ...detected.origin, market: 'local', selection: paths },
            options: { sha: detected.sha, entry: { name: detected.name, source: '.', strict: false, skills: paths } }
          },
          undefined,
          item.controller.signal
        )
        item.preview = preview.token
        await detected.prepared.cleanup()
        item.detection = undefined
        return { kind: 'plugin', preview }
      } finally {
        await selected.cleanup()
      }
    })
  )
}
export function addDetectedMarket(owner: number, id: string, token: string) {
  return run(owner, id, async (item) => {
    const detected = item.detection
    if (!detected || detected.skills || detected.token !== token) throw new Error('Invalid marketplace detection')
    let imported: PreparedPluginSource | undefined
    try {
      let source = detected.source
      if (!source) {
        const parent = await safePluginPath(pluginRoot(), 'market-imports')
        await mkdir(parent, { recursive: true })
        imported = await preparePluginSource({ path: detected.prepared.root, type: 'folder', tempParent: parent, repository: true })
        source = { kind: 'folder', path: imported.root }
      }
      const market = await addMarketSource(source, { signal: item.controller.signal, id })
      imported = undefined // 持久市场快照，生命周期由市场删除处理。
      await detected.prepared.cleanup()
      item.detection = undefined
      return market
    } finally {
      await imported?.cleanup()
    }
  })
}
