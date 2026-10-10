import { it, expect } from 'vitest'
import { runInNewContext } from 'vm'
import { loginBlocked, generatePac, websiteDomain, DomainSchema } from '../browserSafety'
it('detects only relevant Google and YouTube login blocks', () => {
  expect(loginBlocked('https://accounts.google.com/v3/signin')).toBe('google')
  expect(loginBlocked('https://accounts.google.com/signin/rejected')).toBe('google')
  expect(loginBlocked('https://accounts.google.com/', '', '此浏览器或应用可能不安全')).toBe('google')
  expect(loginBlocked('https://www.youtube.com/watch?v=x', '', "Sign in to confirm you're not a bot")).toBe('youtube')
  expect(loginBlocked('https://evil.example/', '', "Sign in to confirm you're not a bot")).toBeNull()
  expect(loginBlocked('http://fixture.local/signin', '', '', ['fixture.local'])).toBe('google')
  expect(loginBlocked('https://accounts.google.com.evil.example/signin')).toBeNull()
})
it('builds safe PAC rules with host boundaries, subdomains and a system fallback', () => {
  const script = generatePac([{ domain: 'bilibili.com', mode: 'direct' }, { domain: 'special.bilibili.com', mode: 'proxy' }], 'PROXY 127.0.0.1:1082; DIRECT')
  const find = runInNewContext(script + '; FindProxyForURL', { dnsDomainIs: (host: string, domain: string) => host.endsWith(domain) }) as (url: string, host: string) => string
  expect(find('', 'www.bilibili.com')).toBe('DIRECT'); expect(find('', 'bilibili.com')).toBe('DIRECT')
  expect(find('', 'special.bilibili.com')).toBe('PROXY 127.0.0.1:1082; DIRECT'); expect(find('', 'evilbilibili.com')).toBe('PROXY 127.0.0.1:1082; DIRECT')
  expect(() => generatePac([], 'PROXY x; evil()')).toThrow(); expect(DomainSchema.safeParse('../x').success).toBe(false)
  expect(websiteDomain('https://www.bilibili.com/video')).toBe('bilibili.com'); expect(websiteDomain('https://www.example.co.uk')).toBe('example.co.uk')
})
