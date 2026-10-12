import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const loadScript = createRequire(import.meta.url)
const { signingOptions } = loadScript('../../../../scripts/mac-signing.cjs') as {
  signingOptions(env: Record<string, string | undefined>): { identity?: string; hardenedRuntime: boolean; notarize: boolean }
}

describe('mac signing build policy', () => {
  it('seals the free app without hardened runtime or notarization', () => {
    expect(signingOptions({})).toEqual({ identity: '-', hardenedRuntime: false, notarize: false })
  })
  it('selects Developer ID with JIT hardening and notarization from complete credentials', () => {
    expect(
      signingOptions({
        CSC_LINK: 'fixture',
        CSC_KEY_PASSWORD: 'fixture',
        APPLE_ID: 'fixture@example.invalid',
        APPLE_APP_SPECIFIC_PASSWORD: 'fixture',
        APPLE_TEAM_ID: 'fixture'
      })
    ).toEqual({ hardenedRuntime: true, notarize: true })
  })
  it('rejects partial paid credentials without echoing their contents', () => {
    expect(() => signingOptions({ CSC_LINK: 'DO_NOT_ECHO' })).toThrow(/required/)
    try {
      signingOptions({ CSC_LINK: 'DO_NOT_ECHO' })
    } catch (error) {
      expect(String(error)).not.toContain('DO_NOT_ECHO')
    }
  })
})
