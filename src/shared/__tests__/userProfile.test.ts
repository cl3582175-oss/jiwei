import { describe, expect, it } from 'vitest'
import { capabilities, parseArgs } from '../capabilities'

describe('personal profile IPC limits', () => {
  it.each([
    ['role', 500],
    ['goals', 6000],
    ['background', 1000],
    ['style', 6000],
    ['avoid', 1000]
  ] as const)('%s accepts its full capacity and rejects overflow', (key, limit) => {
    const patch = { [key]: '档'.repeat(limit) }
    expect(parseArgs(capabilities.memory.setProfile, [patch])).toEqual([patch])
    expect(() => parseArgs(capabilities.memory.setProfile, [{ [key]: '档'.repeat(limit + 1) }])).toThrow('Too big')
  })
})
