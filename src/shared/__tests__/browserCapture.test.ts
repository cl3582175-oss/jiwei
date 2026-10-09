import { describe, expect, it } from 'vitest'
import { captureIdentityValid, capturePixels } from '../browserCapture'

describe('browser capture', () => {
  it('maps scaled selections to a retained Retina frame without crossing its edge', () => {
    expect(capturePixels({ x: 0.1, y: 0.2, w: 0.5, h: 0.3 }, 1600, 1200)).toEqual({ x: 160, y: 240, width: 800, height: 360 })
    expect(capturePixels({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, 801, 601)).toEqual({ x: 720, y: 540, width: 81, height: 61 })
    expect(() => capturePixels({ x: 0.9, y: 0, w: 0.5, h: 1 }, 100, 100)).toThrow()
  })
  it('rejects reload, tab switch, navigation, incognito and sensitive scopes', () => {
    const expected = { tabId: 'tab', scope: 'generation', url: 'https://example.com/' }
    const current = { ...expected, sensitive: false, incognito: false }
    expect(captureIdentityValid(expected, current)).toBe(true)
    for (const patch of [
      { scope: 'reload' },
      { tabId: 'other' },
      { url: 'https://example.com/next' },
      { sensitive: true },
      { incognito: true }
    ])
      expect(captureIdentityValid(expected, { ...current, ...patch })).toBe(false)
    expect(captureIdentityValid(expected, null)).toBe(false)
  })
})
