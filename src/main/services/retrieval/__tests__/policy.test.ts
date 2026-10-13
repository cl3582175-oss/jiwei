import { afterEach, describe, expect, it } from 'vitest'
import { setMessageLanguage } from '../../../lib/messages'
import { currentRun, withPurpose, withRun } from '../../agent/context'
import { assertWebAllowed, WEB_POLICY, WebPolicyError, webPolicyOf } from '../policy'

afterEach(() => setMessageLanguage('zh-CN'))

const allowed = [
  ['chat', 'tool'],
  ['workspace', 'tool'],
  ['inline', 'tool'],
  ['discover.daily', 'pipeline'],
  ['discover.path', 'pipeline'],
  ['discover.remedy', 'pipeline'],
  ['task', 'pipeline'],
  ['search.test', 'pipeline']
] as const

describe('web purpose policy', () => {
  it('declares an explicit policy for every allowed purpose', () => {
    expect(WEB_POLICY).toEqual(Object.fromEntries(allowed))
  })
  it.each(allowed)('allows %s with %s policy in the real run context', (purpose, policy) => {
    expect(webPolicyOf(purpose)).toBe(policy)
    withRun({ purpose }, () => expect(assertWebAllowed).not.toThrow())
    expect(currentRun()).toBeUndefined()
  })
  it.each([
    'feynman',
    'reflection',
    'memory',
    'review',
    'lens',
    'digest',
    'recording',
    'inbox',
    'briefing',
    'plan.schedule',
    'discover.queries',
    'unknown',
    '',
    undefined,
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty'
  ])('denies unlisted purpose %s', (purpose) => {
    expect(webPolicyOf(purpose)).toBe('never')
    if (purpose !== undefined) withRun({ purpose }, () => expect(assertWebAllowed).toThrow(WebPolicyError))
  })
  it('rejects web access without a run', () => {
    expect(currentRun()).toBeUndefined()
    expect(assertWebAllowed).toThrow(WebPolicyError)
  })
  it('uses the nested actual purpose instead of an allowed parent purpose', () => {
    withRun({ purpose: 'chat' }, () => {
      withPurpose('reflection', () => expect(assertWebAllowed).toThrow(WebPolicyError))
      expect(assertWebAllowed).not.toThrow()
    })
  })
  it.each([
    ['zh-CN', '这个功能不使用联网（none）', '这个功能不使用联网（reflection）'],
    ['en', 'Web access is not used by this feature (none)', 'Web access is not used by this feature (reflection)']
  ])('reports the prescribed policy messages in %s', (language, missing, denied) => {
    setMessageLanguage(language)
    expect(assertWebAllowed).toThrow(missing)
    withRun({ purpose: 'reflection' }, () => expect(assertWebAllowed).toThrow(denied))
  })
})
