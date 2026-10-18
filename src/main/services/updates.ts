import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import electronUpdater, { type AppUpdater } from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import log from 'electron-log/main'
import { mirrorUrls, updateMode, type UpdateState } from '@shared/updates'
import { getSettings } from './settings'
import { emit, onMainEvent } from '../events'
import { getStartupUpgrade } from '../db'
import { download, probeMirrors } from './download'
import { verifyUpdateSha512 } from '../lib/updateIntegrity'
import { GitHubMirrorProvider } from '../lib/githubMirrorProvider'
import { requestRendererFlush } from '../lifecycle'
import { flushAll } from './docs'

const { MacUpdater, NsisUpdater, AppImageUpdater } = electronUpdater
const RELEASES = 'https://github.com/cl3582175-oss/jiwei-releases/releases'
const HOUR = 3_600_000
function privateCache(adapter: object): void {
  Object.defineProperty(adapter, 'baseCachePath', { get: () => join(app.getPath('userData'), 'update-cache') })
}
class ManualMacUpdater extends MacUpdater {
  constructor() {
    super()
    privateCache(this.app)
  }
  async dmgFile() {
    if (!this.updateInfoAndProvider) throw new Error('No selected update')
    const { info, provider } = this.updateInfoAndProvider
    const files = provider.resolveFiles(info).filter((file) => file.url.pathname.endsWith('.dmg'))
    const file =
      files.find((f) => f.url.pathname.endsWith(`-${process.arch}.dmg`)) ??
      (files.length === 1 && !/-(arm64|x64)\.dmg$/.test(files[0].url.pathname) ? files[0] : undefined)
    if (!file) throw new Error('No installer for this architecture')
    return file
  }
}
class JiweiNsisUpdater extends NsisUpdater {
  constructor() {
    super()
    privateCache(this.app)
  }
}
class JiweiAppImageUpdater extends AppImageUpdater {
  constructor() {
    super()
    privateCache(this.app)
  }
}

function testFeed(): string | null {
  if (app.isPackaged || process.env.JIWEI_UPDATE_FORCE_PACKAGED !== '1') return null
  try {
    const url = new URL(process.env.JIWEI_UPDATE_FEED ?? '')
    return ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
const testing = (): boolean => testFeed() !== null
let state: UpdateState = { version: app.getVersion(), platform: process.platform, arch: process.arch, mode: 'disabled', status: 'idle' }
let updater: AppUpdater | null = null
let generation = 0
let abort: AbortController | null = null
let cancellation: CancellationToken | null = null
let checkAbort: AbortController | null = null
let downloaded: { path: string; sha512: string } | null = null
let activeSource: string | undefined
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
let initial: NodeJS.Timeout | null = null,
  recurring: NodeJS.Timeout | null = null
let unsubscribe: (() => void) | null = null
let configuredFeed = '',
  configuredAuto = true,
  developerId = false,
  upgradeDismissed = false

export function getUpdateState(): UpdateState {
  return { ...state, upgrade: upgradeDismissed ? null : getStartupUpgrade() }
}
function publish(patch: Partial<UpdateState>, owner = generation): void {
  if (owner !== generation) return
  state = { ...state, ...patch }
  emit('updates:changed', getUpdateState())
}
function fail(error: unknown, owner = generation): void {
  if (owner !== generation) return
  const message = error instanceof Error ? error.message : ''
  const code: UpdateState['error'] = /EACCES|EPERM|ENOSPC|EDQUOT|EIO|EROFS|EEXIST/.test(message)
    ? 'storage'
    : /checksum|sha512/i.test(message)
      ? 'checksum'
      : /ENOTFOUND|ERR_INTERNET_DISCONNECTED|EAI_AGAIN/.test(message)
        ? 'offline'
        : 'server'
  log.warn('[updates] operation failed', code)
  publish({ status: 'error', error: code }, owner)
}
function clearSchedule(): void {
  if (initial) clearTimeout(initial)
  if (recurring) clearInterval(recurring)
  initial = recurring = null
}
function schedule(): void {
  clearSchedule()
  if (!configuredAuto || state.mode === 'disabled') return
  const delay = testing() ? Math.max(100, Math.min(30000, Number(process.env.JIWEI_UPDATE_CHECK_DELAY) || 30000)) : 30000
  initial = setTimeout(() => void checkUpdates(), delay)
  recurring = setInterval(() => void checkUpdates(), 6 * HOUR)
}
function configure(): void {
  generation++
  checkAbort?.abort()
  abort?.abort()
  cancellation?.cancel()
  if (updater) {
    updater.autoInstallOnAppQuit = false
    updater.removeAllListeners()
    updater.on('error', () => undefined)
  }
  updater = null
  downloaded = null
  const preferences = getSettings().updates ?? { autoCheck: true, feedUrl: '' }
  configuredFeed = preferences.feedUrl.trim()
  configuredAuto = preferences.autoCheck
  const platform =
    testing() && ['darwin', 'win32', 'linux'].includes(process.env.JIWEI_UPDATE_PLATFORM ?? '')
      ? process.env.JIWEI_UPDATE_PLATFORM!
      : process.platform
  const mode = updateMode({ platform, packaged: app.isPackaged || testing(), signed: developerId, appImage: !!process.env.APPIMAGE })
  state = { version: app.getVersion(), platform, arch: process.arch, mode, status: 'idle' }
  if (mode !== 'disabled') {
    const instance =
      platform === 'darwin'
        ? new ManualMacUpdater()
        : platform === 'linux' && mode === 'automatic'
          ? new JiweiAppImageUpdater()
          : new JiweiNsisUpdater()
    updater = instance
    if (testing()) {
      const path = join(app.getPath('userData'), 'update-test.yml')
      writeFileSync(path, JSON.stringify({ provider: 'generic', url: testFeed(), updaterCacheDirName: 'jiwei-updater' }), { mode: 0o600 })
      instance.updateConfigPath = path
    }
    const owner = generation
    instance.logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
    instance.forceDevUpdateConfig = testing()
    instance.autoDownload = false
    instance.autoInstallOnAppQuit = mode === 'automatic' && !testing()
    instance.disableDifferentialDownload = testing()
    instance.allowDowngrade = false
    instance.allowPrerelease = false
    const feed = testFeed() ?? configuredFeed
    checkAbort = new AbortController()
    instance.setFeedURL(
      feed ? { provider: 'generic', url: feed } : { provider: 'custom', updateProvider: GitHubMirrorProvider, signal: checkAbort.signal }
    )
    instance.on('checking-for-update', () => publish({ status: 'checking', error: undefined }, owner))
    instance.on('update-not-available', () => publish({ status: 'current', nextVersion: undefined, error: undefined }, owner))
    instance.on('update-available', (info) => {
      const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : info.releaseNotes?.map((item) => item.note).join('\n')
      publish(
        {
          status: 'available',
          nextVersion: info.version,
          notes: notes?.slice(0, 200000),
          notesTruncated: (notes?.length ?? 0) > 200000,
          error: undefined
        },
        owner
      )
      if (owner === generation && mode === 'automatic') void downloadUpdate()
    })
    instance.on('download-progress', (progress) =>
      publish(
        {
          status: 'downloading',
          percent: Math.min(100, Math.max(0, progress.percent)),
          speed: progress.bytesPerSecond,
          source: activeSource
        },
        owner
      )
    )
    instance.on('update-downloaded', () => publish({ status: 'ready', percent: 100, error: undefined }, owner))
    instance.on('error', (error) => fail(error, owner))
  }
  publish({})
  schedule()
}
export async function startUpdates(): Promise<void> {
  if (app.isPackaged && process.platform === 'darwin') {
    const application = dirname(dirname(dirname(app.getPath('exe'))))
    try {
      const result = await promisify(execFile)('/usr/bin/codesign', ['-dv', '--verbose=4', application])
      if (/Authority=Developer ID Application:/.test(result.stderr)) {
        await promisify(execFile)('/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
        developerId = true
      }
    } catch {
      developerId = false
    }
  }
  configure()
  unsubscribe = onMainEvent('settings:changed', () => {
    const preferences = getSettings().updates ?? { autoCheck: true, feedUrl: '' }
    if (preferences.feedUrl.trim() !== configuredFeed) configure()
    else if (preferences.autoCheck !== configuredAuto) {
      configuredAuto = preferences.autoCheck
      schedule()
    }
  })
}
export function stopUpdates(): void {
  generation++
  checkAbort?.abort()
  clearSchedule()
  unsubscribe?.()
  unsubscribe = null
  abort?.abort()
  cancellation?.cancel()
}
export async function checkUpdates(): Promise<UpdateState> {
  if (!updater || state.status === 'downloading') return getUpdateState()
  const owner = generation
  try {
    await updater.checkForUpdates()
  } catch (error) {
    fail(error, owner)
  }
  return getUpdateState()
}
export async function downloadUpdate(): Promise<UpdateState> {
  if (!updater || !state.nextVersion || state.mode === 'download-page' || state.status === 'downloading' || state.status === 'ready')
    return getUpdateState()
  const instance = updater,
    owner = generation
  publish({ status: 'downloading', percent: 0, error: undefined }, owner)
  if (state.mode === 'mac-manual') {
    const controller = new AbortController()
    abort = controller
    let destination: string | null = null
    try {
      if (!(instance instanceof ManualMacUpdater)) throw new Error('Invalid platform updater')
      const file = await instance.dmgFile(),
        size = file.info.size
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new Error('Missing installer size')
      if (file.url.protocol !== 'https:' && !(testing() && file.url.hostname === '127.0.0.1')) throw new Error('Untrusted update transport')
      const directory = testing() ? process.env.JIWEI_UPDATE_DOWNLOADS! : app.getPath('downloads')
      destination = join(directory, `Jiwei-${state.nextVersion}-mac-${process.arch}-${randomUUID().slice(0, 8)}.dmg`)
      // 镜像测速选最快的，变慢自动换；4 段并行。校验值来自本次选中的版本信息。
      await download(
        { name: 'Jiwei update', urls: mirrorUrls(file.url.href), dest: destination, size, sha512: file.info.sha512, parallel: 4 },
        (progress) =>
          publish({ percent: (100 * progress.received) / progress.total, speed: progress.speed, source: progress.mirror }, owner),
        controller.signal
      )
      await verifyUpdateSha512(destination, file.info.sha512)
      if (owner === generation) {
        downloaded = { path: destination, sha512: file.info.sha512 }
        publish({ status: 'ready', percent: 100 }, owner)
      }
    } catch (error) {
      if (destination) await Promise.all([rm(destination, { force: true }), rm(destination + '.part', { force: true })])
      if (!controller.signal.aborted) fail(error, owner)
    }
  } else {
    const token = new CancellationToken()
    cancellation = token
    // Windows / Linux 仍由 electron-updater 下载和安装（保留它的增量下载、校验与安装流程），
    // 只把安装包地址换成测速最快的镜像；失败时依次换下一个来源。
    const routes = await rankRoutes(instance)
    for (let i = 0; i < routes.length; i++) {
      if (owner !== generation || token.cancelled) break
      routeVia(instance, routes[i])
      try {
        await instance.downloadUpdate(token)
        break
      } catch (error) {
        if (token.cancelled) break
        log.warn('[updates] download failed via', hostOf(routes[i] ?? ''))
        if (i === routes.length - 1) fail(error, owner)
        else publish({ status: 'downloading', error: undefined }, owner)
      }
    }
    routeVia(instance, null)
  }
  return getUpdateState()
}
type ResolvedFile = { url: URL }
type ProviderLike = { resolveFiles(info: unknown): ResolvedFile[] }
type WithProvider = {
  updateInfoAndProvider?: { info: unknown; provider: ProviderLike & { __jiweiResolve?: ProviderLike['resolveFiles'] } }
}
/** 当前版本安装包的可选来源：按测速排序（测不出来时按镜像在前的原顺序） */
async function rankRoutes(instance: AppUpdater): Promise<(string | null)[]> {
  const chosen = (instance as unknown as WithProvider).updateInfoAndProvider
  if (!chosen) return [null]
  const files = chosen.provider.resolveFiles(chosen.info)
  const main = files.find((f) => /\.(exe|AppImage)$/.test(f.url.pathname)) ?? files[0]
  if (!main) return [null]
  const urls = mirrorUrls(main.url.href)
  if (urls.length === 1) return [null]
  const ranked = (await probeMirrors(urls)).map((r) => r.url)
  const order = [...ranked, ...urls.filter((u) => !ranked.includes(u))]
  log.info('[updates] routes', order.map(hostOf).join(' > '))
  // 记下镜像前缀（原地址记为空前缀）
  return order.map((u) => (u === main.url.href ? '' : u.slice(0, u.length - main.url.href.length)))
}
/** 把 provider 解析出的 GitHub 地址加上镜像前缀；null 恢复原样 */
function routeVia(instance: AppUpdater, prefix: string | null): void {
  const chosen = (instance as unknown as WithProvider).updateInfoAndProvider
  if (!chosen) return
  const provider = chosen.provider
  provider.__jiweiResolve ??= provider.resolveFiles.bind(provider)
  const original = provider.__jiweiResolve
  activeSource = prefix ? hostOf(prefix) : prefix === '' ? 'github.com' : undefined
  provider.resolveFiles = prefix ? (info) => original(info).map((f) => ({ ...f, url: new URL(prefix + f.url.href) })) : original
}
export async function installUpdate(): Promise<void> {
  if (state.status !== 'ready') throw new Error('No verified update is ready')
  const owner = generation,
    selectedUpdater = updater,
    artifact = downloaded
  if (state.mode === 'mac-manual') {
    if (!artifact) throw new Error('Missing verified installer')
    try {
      await verifyUpdateSha512(artifact.path, artifact.sha512)
    } catch (error) {
      fail(error, owner)
      return
    }
    if (owner !== generation) return
    if (testing()) return
    await requestRendererFlush()
    flushAll()
    if (owner !== generation) return
    const result = await shell.openPath(artifact.path)
    if (result) {
      publish({ status: 'error', error: 'download' })
      return
    }
    app.quit()
  } else if (state.mode === 'automatic' && selectedUpdater) {
    if (testing()) return
    await requestRendererFlush()
    flushAll()
    if (owner !== generation) return
    selectedUpdater.quitAndInstall(true, true)
  }
}
export function acknowledgeUpgrade(): void {
  upgradeDismissed = true
  publish({})
}
export async function openUpdateLink(value?: string): Promise<void> {
  const url = new URL(value ?? RELEASES)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe update link')
  try {
    await shell.openExternal(url.href)
  } catch {
    throw new Error('Unable to open update link')
  }
}
