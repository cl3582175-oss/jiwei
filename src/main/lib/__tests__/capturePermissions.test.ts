import { it, expect } from 'vitest'
import { screenPermissionAction } from '../../services/capture/permissions'
it('explains once, suppresses repeated denied prompts, and recovers after system authorization', () => {
  expect(screenPermissionAction('not-determined', false)).toBe('explain')
  expect(screenPermissionAction('not-determined', true)).toBe('deny')
  expect(screenPermissionAction('denied', false)).toBe('deny')
  expect(screenPermissionAction('restricted', true)).toBe('deny')
  expect(screenPermissionAction('granted', true)).toBe('capture')
})
