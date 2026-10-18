import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { RequestOptions } from 'node:http'
import { stringify } from 'yaml'
import type { AppUpdater } from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { GitHubMirrorProvider } from '../githubMirrorProvider'

const checksum = createHash('sha512').update('controlled metadata, not an installer').digest('base64')
const file = { url: 'Jiwei-1.2.3-mac-arm64.dmg', size: 42, sha512: checksum }
const metadata = () => ({ version: '1.2.3', files: [{ ...file }], path: file.url, sha512: checksum, releaseNotes: 'Mirror notes' })
const urlOf = (options: RequestOptions) => `${options.protocol}//${options.hostname}${options.path}`
function fixture(handler: (url: string, token: CancellationToken) => Promise<string>, signal?: AbortSignal) {
  const requests: { url: string; headers: RequestOptions['headers'] }[] = []
  const request = async (options: RequestOptions, token: CancellationToken) => {
    const url = urlOf(options)
    requests.push({ url, headers: options.headers })
    return handler(url, token)
  }
  const updater = {
    channel: null,
    isAddNoCacheQuery: true,
    allowPrerelease: false,
    currentVersion: { raw: '0.14.17' }
  } as unknown as AppUpdater
  const runtime = { platform: 'darwin', executor: { request }, isUseMultipleRangeRequest: true } as unknown as ProviderRuntimeOptions
  const provider = new GitHubMirrorProvider({ provider: 'custom', signal }, updater, runtime)
  provider.setRequestHeaders({ 'x-user-staging-id': 'private-device-id', Authorization: 'private-test-token' })
  return { provider, requests }
}
afterEach(() => vi.useRealTimers())

it('keeps GitHub when it works and never contacts a mirror', async () => {
  const { provider, requests } = fixture(async (url) => {
    if (url.endsWith('.atom'))
      return '<feed><entry><title>Version</title><link href="https://github.com/cl3582175-oss/jiwei-releases/releases/tag/v1.2.3"/><content>GitHub notes</content></entry></feed>'
    if (url.endsWith('/latest')) return JSON.stringify({ tag_name: 'v1.2.3' })
    return stringify(metadata())
  })
  expect((await provider.getLatestVersion()).version).toBe('1.2.3')
  expect(requests).toHaveLength(3)
  expect(requests.every(({ url }) => new URL(url).hostname === 'github.com')).toBe(true)
})

it('falls back without disclosing SDK device headers and pins payloads to the selected release', async () => {
  const { provider, requests } = fixture(async (url) => {
    if (new URL(url).hostname === 'github.com') throw new Error('GitHub blocked')
    return stringify(metadata())
  })
  const info = await provider.getLatestVersion()
  expect(info.tag).toBe('v1.2.3')
  expect(provider.resolveFiles(info)[0].url.href).toBe(
    'https://github.com/cl3582175-oss/jiwei-releases/releases/download/v1.2.3/Jiwei-1.2.3-mac-arm64.dmg'
  )
  expect(requests[1].url).toContain(
    'https://gh-proxy.com/https://github.com/cl3582175-oss/jiwei-releases/releases/latest/download/latest-mac.yml'
  )
  expect(JSON.stringify(requests[1].headers)).not.toMatch(/private|staging|authorization/i)
  expect(provider.isUseMultipleRangeRequest).toBe(false)
})

it('tries the second mirror when the first returns HTML', async () => {
  const { provider, requests } = fixture(async (url) => {
    if (new URL(url).hostname === 'github.com') throw new Error('GitHub blocked')
    return url.startsWith('https://gh-proxy.com/') ? '<html>Blocked</html>' : stringify(metadata())
  })
  expect((await provider.getLatestVersion()).version).toBe('1.2.3')
  expect(requests.some(({ url }) => url.startsWith('https://ghfast.top/'))).toBe(true)
})

it.each(['../escape.dmg', 'https://other.test/installer.dmg', 'Jiwei-1.2.2-mac-arm64.dmg', 'Jiwei-1.2.3-mac-arm64.dmg?token=secret'])(
  'rejects a mirror file outside the selected official release: %s',
  async (url) => {
    const { provider } = fixture(async (source) => {
      if (new URL(source).hostname === 'github.com') throw new Error('GitHub blocked')
      const info = metadata()
      info.files[0].url = url
      info.path = url
      return stringify(info)
    })
    await expect(provider.getLatestVersion()).rejects.toThrow('GitHub and update mirrors are unavailable')
  }
)

it.each(['1.2.3-beta.1', 'not-a-version', '1.2.03'])('rejects non-stable mirror versions: %s', async (version) => {
  const { provider } = fixture(async (source) => {
    if (new URL(source).hostname === 'github.com') throw new Error('GitHub blocked')
    return stringify({ ...metadata(), version })
  })
  await expect(provider.getLatestVersion()).rejects.toThrow('GitHub and update mirrors are unavailable')
})

it('rejects alternate package paths rather than allowing SDK package resolution to escape', async () => {
  const { provider } = fixture(async (source) => {
    if (new URL(source).hostname === 'github.com') throw new Error('GitHub blocked')
    return stringify({ ...metadata(), packages: { x64: { path: 'https://other.test/package.7z' } } })
  })
  await expect(provider.getLatestVersion()).rejects.toThrow('GitHub and update mirrors are unavailable')
})

it('aborts an actual pending request after the source deadline before using a mirror', async () => {
  vi.useFakeTimers()
  let aborted = false
  const { provider } = fixture(async (url, token) => {
    if (new URL(url).hostname !== 'github.com') return stringify(metadata())
    return token.createPromise<string>((_resolve, _reject, onCancel) =>
      onCancel(() => {
        aborted = true
      })
    )
  })
  const pending = provider.getLatestVersion()
  await vi.advanceTimersByTimeAsync(8000)
  expect((await pending).version).toBe('1.2.3')
  expect(aborted).toBe(true)
})

it('cancels the whole check when changing source or exiting, without starting mirrors', async () => {
  const controller = new AbortController()
  let aborted = false
  const { provider, requests } = fixture(
    async (_url, token) =>
      token.createPromise<string>((_resolve, _reject, onCancel) =>
        onCancel(() => {
          aborted = true
        })
      ),
    controller.signal
  )
  const pending = provider.getLatestVersion()
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(aborted).toBe(true)
  expect(requests).toHaveLength(1)
})

it('keeps a discovered version if optional release notes are unavailable', async () => {
  const { provider } = fixture(async (source) => {
    if (new URL(source).hostname === 'github.com' || source.includes('api.github.com')) throw new Error('Unavailable')
    const { releaseNotes: _notes, ...info } = metadata()
    return stringify(info)
  })
  expect((await provider.getLatestVersion()).version).toBe('1.2.3')
})

it('only supplements notes from the same published stable release', async () => {
  const { provider } = fixture(async (source) => {
    if (new URL(source).hostname === 'github.com') throw new Error('GitHub blocked')
    if (source.includes('api.github.com'))
      return JSON.stringify({ tag_name: 'v1.2.3', draft: false, prerelease: false, body: 'Approved notes' })
    const { releaseNotes: _notes, ...info } = metadata()
    return stringify(info)
  })
  expect((await provider.getLatestVersion()).releaseNotes).toBe('Approved notes')
})
