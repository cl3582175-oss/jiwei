import { describe, expect, it } from 'vitest'
import { aiTools, capabilities, parseArgs } from '../capabilities'
import { BACKEND_IDS } from '../retrieval'

describe('retrieval IPC contracts', () => {
  it('registers the requested UI capabilities without exposing key management to model tools', () => {
    expect(Object.keys(capabilities.retrieval)).toEqual([
      'upgradeStatus',
      'status',
      'saveBackend',
      'testBackend',
      'page',
      'savePage',
      'clearCache',
      'usage'
    ])
    expect(aiTools().some((tool) => tool.name.startsWith('retrieval_'))).toBe(false)
    expect(parseArgs(capabilities.retrieval.status, [])).toEqual([])
    expect(parseArgs(capabilities.retrieval.clearCache, [])).toEqual([])
  })
  it.each(BACKEND_IDS)('allows only a supported backend for tests (%s)', (id) => {
    expect(parseArgs(capabilities.retrieval.testBackend, [id])).toEqual([id])
  })
  it('rejects malformed write/test/range inputs at the capability boundary', () => {
    expect(() => parseArgs(capabilities.retrieval.testBackend, ['unknown'])).toThrow()
    expect(() => parseArgs(capabilities.retrieval.saveBackend, [{ id: 'bocha', enabled: 'true' }])).toThrow()
    expect(() => parseArgs(capabilities.retrieval.saveBackend, [{ id: 'bocha', enabled: true, key: 'x'.repeat(4001) }])).toThrow()
    expect(() => parseArgs(capabilities.retrieval.usage, ['year'])).toThrow()
    expect(() => parseArgs(capabilities.retrieval.page, [''])).toThrow()
  })
  it.each(['today', 'month'])('preserves the requested accounting range (%s)', (range) => {
    expect(parseArgs(capabilities.retrieval.usage, [range])).toEqual([range])
  })
})
