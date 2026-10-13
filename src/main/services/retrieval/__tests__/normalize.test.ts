import { describe, expect, it } from 'vitest'
import { canonicalUrl, urlKey } from '../backends/normalize'

describe('retrieval URL normalization', () => {
  it('keeps the saved www hostname and scheme while lowering the host', () => {
    expect(canonicalUrl('HTTP://WWW.Example.ORG/story/#fragment')).toBe('http://www.example.org/story')
  })
  it.each([
    'utm_source',
    'utm_custom',
    'spm',
    'from',
    'share',
    'share_source',
    'share_medium',
    'fbclid',
    'gclid',
    'ref',
    'ref_src',
    'source',
    'timestamp',
    '_t'
  ])('removes tracking parameter %s and retains meaningful parameters', (name) => {
    expect(canonicalUrl(`https://example.org/read?b=2&${name}=tracking&a=1`)).toBe('https://example.org/read?a=1&b=2')
  })
  it('removes every tracking occurrence while retaining duplicate meaningful values', () => {
    expect(canonicalUrl('https://example.org/?utm_id=1&a=2&utm_id=3&a=1')).toBe('https://example.org/?a=2&a=1')
  })
  it.each([
    ['https://example.org/a///', 'https://example.org/a'],
    ['https://example.org/', 'https://example.org/'],
    ['https://example.org', 'https://example.org/'],
    ['https://example.org/a%2F', 'https://example.org/a%2F'],
    ['https://example.org/read?z=3&a=1&b=2', 'https://example.org/read?a=1&b=2&z=3'],
    ['https://example.org/中文/?主题=检索&a=1', 'https://example.org/%E4%B8%AD%E6%96%87?a=1&%E4%B8%BB%E9%A2%98=%E6%A3%80%E7%B4%A2'],
    ['https://例子.测试/文章/', 'https://xn--fsqu00a.xn--0zwm56d/%E6%96%87%E7%AB%A0'],
    ['http://WWW.example.org:8080/read/', 'http://www.example.org:8080/read'],
    ['https://[2001:DB8::1]:8443/read/', 'https://[2001:db8::1]:8443/read']
  ])('normalizes %s without losing meaningful identity', (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected)
  })
  it('makes only the comparison key scheme- and www-insensitive', () => {
    expect(urlKey('http://www.example.org:8080/read/?utm_id=1&b=2&a=1')).toBe('https://example.org:8080/read?a=1&b=2')
    expect(urlKey('https://example.org:8080/read?a=1&b=2')).toBe('https://example.org:8080/read?a=1&b=2')
    expect(canonicalUrl('http://www.example.org:8080/read')).toBe('http://www.example.org:8080/read')
  })
  it('preserves non-www subdomains, paths and non-default ports in the comparison key', () => {
    expect(urlKey('http://api.example.org:8080/read')).toBe('https://api.example.org:8080/read')
    expect(urlKey('http://api.example.org:8081/read')).toBe('https://api.example.org:8081/read')
    expect(urlKey('http://www.example.org/Read')).toBe('https://example.org/Read')
  })
  it.each([
    '',
    'not a URL',
    '/relative',
    'https://',
    'https://example.org:99999/a',
    'file:///tmp/example',
    'javascript:alert(1)',
    'ftp://example.org/a',
    'https://user:password@example.org/a'
  ])('rejects invalid or unsupported URL %s', (input) => {
    expect(canonicalUrl(input)).toBeNull()
    expect(urlKey(input)).toBeNull()
  })
})
