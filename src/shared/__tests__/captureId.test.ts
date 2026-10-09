import { describe, expect, it } from 'vitest'
import { CourseAudioStartSchema } from '../schemas'

describe('course audio capture id', () => {
  const base = { scope: 's', media: 'm', url: 'https://a.com/v' }
  it('rejects path traversal and separators (used as a directory name)', () => {
    for (const capture of ['../..', '..', 'a/b', 'a\\b', '', 'x'.repeat(65)])
      expect(CourseAudioStartSchema.safeParse({ ...base, capture }).success).toBe(false)
  })
  it('accepts generated ids', () => {
    expect(CourseAudioStartSchema.safeParse({ ...base, capture: '3f2b1c9e-7a4d-4e1f-9b2a-0c6d5e4f3a21' }).success).toBe(true)
  })
})
