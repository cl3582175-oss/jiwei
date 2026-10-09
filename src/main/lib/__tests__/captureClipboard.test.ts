import { expect, it } from 'vitest'
import { ClipboardRecency } from '../../services/capture/clipboardRecency'
it('existing clipboard is not fresh and observations expire after 30 seconds', () => {
  const clock = new ClipboardRecency()
  clock.observe('old', 100)
  expect(clock.fresh(100)).toBe(false)
  clock.observe('old', 200)
  expect(clock.fresh(200)).toBe(false)
  clock.observe('new', 300)
  expect(clock.fresh(30300)).toBe(true)
  expect(clock.fresh(30301)).toBe(false)
})
