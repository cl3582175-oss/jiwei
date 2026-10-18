import type { AppUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { CancellationError, CancellationToken, type CustomPublishOptions, type UpdateInfo } from 'builder-util-runtime'
import { UPDATE_MIRRORS } from '@shared/updates'

const REPOSITORY = 'cl3582175-oss/jiwei-releases'
const GITHUB = `https://github.com/${REPOSITORY}/releases/`
const CHECK_TIMEOUT = 8000
type Attempt = { token?: CancellationToken; mirror: boolean }

/** Keep SDK selection/installation, adding only a metadata fallback for the default feed. */
export class GitHubMirrorProvider extends GitHubProvider {
  private readonly attempt: Attempt
  private readonly runtime: ProviderRuntimeOptions
  private readonly appUpdater: AppUpdater
  private readonly signal?: AbortSignal

  constructor(options: CustomPublishOptions & { signal?: AbortSignal }, updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    const attempt: Attempt = { mirror: false }
    const executor = new Proxy(runtime.executor, {
      get(target, property, receiver) {
        if (property !== 'request') return Reflect.get(target, property, receiver)
        return (request: Parameters<typeof target.request>[0], sdkToken = new CancellationToken()) => {
          const active = attempt.token
          const token = new CancellationToken(sdkToken)
          const cancel = () => token.cancel()
          if (active?.cancelled) token.cancel()
          else active?.once('cancel', cancel)
          // Mirrors only need public requests; do not disclose staging IDs or credentials.
          const safeRequest = attempt.mirror ? { ...request, headers: { accept: 'application/json, text/yaml, */*' } } : request
          return target.request(safeRequest, token).finally(() => {
            active?.removeListener('cancel', cancel)
            token.dispose()
          })
        }
      }
    })
    const wrapped = { ...runtime, executor, isUseMultipleRangeRequest: false }
    super({ provider: 'github', owner: 'cl3582175-oss', repo: 'jiwei-releases' }, updater, wrapped)
    this.attempt = attempt
    this.runtime = wrapped
    this.appUpdater = updater
    this.signal = options.signal
    this.signal?.addEventListener('abort', () => this.attempt.token?.cancel(), { once: true })
  }

  private async requestAttempt<T>(mirror: boolean, operation: () => Promise<T>, timeout = CHECK_TIMEOUT): Promise<T> {
    if (this.signal?.aborted) throw new CancellationError()
    const token = new CancellationToken()
    this.attempt.token = token
    this.attempt.mirror = mirror
    const timer = setTimeout(() => token.cancel(), timeout)
    try {
      const result = await operation()
      if (this.signal?.aborted) throw new CancellationError()
      return result
    } finally {
      clearTimeout(timer)
      token.cancel()
      this.attempt.token = undefined
    }
  }

  override async getLatestVersion(): ReturnType<GitHubProvider['getLatestVersion']> {
    try {
      return await this.requestAttempt(false, () => super.getLatestVersion())
    } catch {
      if (this.signal?.aborted) throw new CancellationError()
    }
    for (const mirror of UPDATE_MIRRORS) {
      try {
        const info = await this.requestAttempt(true, async () => {
          const provider = new GenericProvider(
            { provider: 'generic', url: mirror + GITHUB + 'latest/download/', useMultipleRangeRequest: false },
            this.appUpdater,
            this.runtime
          )
          const result = await provider.getLatestVersion()
          validateMirrorInfo(result)
          return result
        })
        // Old metadata has no notes (GitHubProvider normally gets them from Atom).
        if (info.releaseNotes == null) {
          try {
            const raw = await this.requestAttempt(
              true,
              () => this.httpRequest(new URL(`${mirror}https://api.github.com/repos/${REPOSITORY}/releases/tags/v${info.version}`)),
              1500
            )
            const release = JSON.parse(raw ?? '')
            if (
              release.tag_name === `v${info.version}` &&
              release.draft === false &&
              release.prerelease === false &&
              typeof release.body === 'string'
            )
              info.releaseNotes = release.body
          } catch {
            if (this.signal?.aborted) throw new CancellationError()
          }
        }
        return { ...info, tag: `v${info.version}` }
      } catch {
        if (this.signal?.aborted) throw new CancellationError()
      }
    }
    throw new Error('GitHub and update mirrors are unavailable')
  }
}

function validateMirrorInfo(info: UpdateInfo): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(info.version)) throw new Error('Invalid stable mirror version')
  const filename = (value: unknown) =>
    typeof value === 'string' && value.startsWith(`Jiwei-${info.version}-`) && /^[A-Za-z0-9._-]+$/.test(value)
  if (
    !Array.isArray(info.files) ||
    !info.files.length ||
    info.files.some(
      (file) => !filename(file.url) || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) || !Number.isSafeInteger(file.size) || file.size! <= 0
    ) ||
    (info.path !== undefined && !info.files.some((file) => file.url === info.path)) ||
    (info as UpdateInfo & { packages?: unknown }).packages !== undefined
  )
    throw new Error('Untrusted mirror asset reference')
}
