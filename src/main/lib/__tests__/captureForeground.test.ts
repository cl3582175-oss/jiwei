import { expect, it, vi } from 'vitest'
import { collectBrowserOrigin, eligibleBrowser, parseForeground } from '../../services/capture/foreground'
const normal = { privacy: 'normal', windowId: 1, tabId: 2, url: 'https://example.com/reading' }
it('only enables detail probes for browser identities with known privacy support', () => {
  expect(eligibleBrowser('com.google.Chrome')).toBe('Google Chrome')
  expect(eligibleBrowser('com.microsoft.edgemac')).toBe('Microsoft Edge')
  for (const bundle of ['com.apple.Safari', 'company.thebrowser.Browser', 'unknown', '__proto__', 'constructor']) {
    expect(eligibleBrowser(bundle)).toBeNull()
  }
})
it('only keeps the app when privacy is private, unknown, or absent', async () => {
  for (const privacy of ['private', 'unknown', undefined]) {
    const details = vi.fn(async () => ({ ...normal, title: 'secret' }))
    expect(await collectBrowserOrigin('Google Chrome', async () => ({ ...normal, privacy }), details)).toEqual({ app: 'Google Chrome' })
    expect(details).not.toHaveBeenCalled()
  }
  expect(parseForeground('Safari\nPrivate title\nhttps://example.com')).toEqual({ app: 'Safari' })
  expect(parseForeground('Arc\nPrivate title\nhttps://example.com')).toEqual({ app: 'Arc' })
})
it('filters sensitive, user-blocked, invalid, and credential-bearing URLs before requesting title', async () => {
  for (const url of [
    'https://mail.google.com/inbox',
    'https://example.com/login',
    'https://secret.example/read',
    'file:///private',
    'https://user:pass@example.com',
    'https://example.com/?access_token=secret'
  ]) {
    const details = vi.fn(async () => ({ ...normal, url, title: 'secret' }))
    expect(await collectBrowserOrigin('Google Chrome', async () => ({ ...normal, url }), details, ['secret.example'])).toEqual({
      app: 'Google Chrome'
    })
    expect(details).not.toHaveBeenCalled()
  }
})
it('requires the same normal window, tab and URL before accepting details', async () => {
  for (const patch of [
    { privacy: 'private' },
    { privacy: 'unknown' },
    { windowId: 3 },
    { tabId: 4 },
    { url: 'https://mail.google.com/' }
  ]) {
    expect(
      await collectBrowserOrigin(
        'Microsoft Edge',
        async () => normal,
        async () => ({ ...normal, title: 'secret', ...patch })
      )
    ).toEqual({ app: 'Microsoft Edge' })
  }
  expect(
    await collectBrowserOrigin(
      'Google Chrome',
      async () => normal,
      async () => ({ ...normal, title: 'Reading' })
    )
  ).toEqual({ app: 'Google Chrome', windowTitle: 'Reading', url: normal.url })
})
