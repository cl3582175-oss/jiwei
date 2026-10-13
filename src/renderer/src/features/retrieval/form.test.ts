import { describe, expect, it } from 'vitest'
import { normalizeSearxngAddress, normalizeSiteLines } from './form'

describe('retrieval website form normalization', () => {
  it('normalizes protocols, paths, ports, case and duplicate domains while counting invalid lines', () => {
    expect(
      normalizeSiteLines(
        'HTTPS://Example.ORG:443/read?id=1\nexample.org\nNews.EXAMPLE:8080/story\n\nbad domain\n*.example.org\nhttps://user:pass@example.org\nftp://example.org'
      )
    ).toEqual({
      sites: ['example.org', 'news.example'],
      dropped: 4
    })
  })
  it('normalizes international domains and a root dot without dropping legal rows at the 200 item boundary', () => {
    expect(normalizeSiteLines('https://例子.中国/a\nEXAMPLE.ORG.')).toEqual({
      sites: ['xn--fsqu00a.xn--fiqs8s', 'example.org'],
      dropped: 0
    })
    const text = Array.from({ length: 201 }, (_, index) => `s${index}.example.org`).join('\n')
    expect(normalizeSiteLines(text).sites).toHaveLength(201)
    expect(normalizeSiteLines(text).dropped).toBe(0)
  })
  it('counts malformed and overlong domain rows without treating blank lines as errors', () => {
    expect(normalizeSiteLines('\nhttps://\n-bad.example\n' + 'a'.repeat(64) + '.example.org\n')).toEqual({ sites: [], dropped: 3 })
  })
})

describe('SearXNG immediate validation', () => {
  it.each([
    'https://search.example.org',
    'http://127.0.0.1:8888',
    'http://localhost:8888/search',
    'http://[::1]:8888',
    'http://10.0.0.2',
    'http://172.16.2.3',
    'http://192.168.1.20',
    'http://search.local'
  ])('allows a public HTTPS or local instance: %s', (value) => expect(normalizeSearxngAddress(value)).not.toBeNull())
  it.each([
    'http://example.com',
    'ftp://search.example.org',
    'javascript:alert(1)',
    'https://user:pass@search.example.org',
    'https://search.example.org?q=test',
    'https://search.example.org#fragment',
    'http://172.32.0.1',
    '',
    'not an address'
  ])('rejects an unsafe or malformed address: %s', (value) => expect(normalizeSearxngAddress(value)).toBeNull())
  it('trims outer whitespace and trailing slash without changing the instance path', () => {
    expect(normalizeSearxngAddress(' https://Search.Example.org/instance/// ')).toBe('https://search.example.org/instance')
  })
})
