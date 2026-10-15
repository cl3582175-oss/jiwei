import { expect, it } from 'vitest'
import { hashText } from '../derive'
it('hashes all parts of structured evidence while retaining two-part identity', () => {
  expect(hashText('paragraph', '合成证据必须完整保存。')).toBe('ad39de4a54c536496e20115254b323c00a57d20d')
  expect(hashText('paragraph', 'heading', 'first')).not.toBe(hashText('paragraph', 'heading', 'second'))
  expect(hashText('paragraph', 'heading', 'first')).not.toBe(hashText('paragraph', 'other', 'first'))
})
