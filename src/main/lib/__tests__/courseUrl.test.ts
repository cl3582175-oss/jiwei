import { expect, it } from 'vitest'
import { canonicalUrl } from '../browserPolicy'

it('B站分P身份保留，播放时间与跟踪参数不创建新资料', () => {
  expect(canonicalUrl('https://www.bilibili.com/video/BV1?p=2&t=24&spm=abc#x')).toBe('https://www.bilibili.com/video/BV1?p=2')
  expect(canonicalUrl('https://www.bilibili.com/video/BV1?p=1')).not.toBe(canonicalUrl('https://www.bilibili.com/video/BV1?p=2'))
  expect(canonicalUrl('https://example.com/article?t=important')).toContain('t=important')
})

it('已打开的视频用相同身份回跳，YouTube视频ID不同仍区分', () => {
  expect(canonicalUrl('https://www.youtube.com/watch?v=lesson1&t=90&utm_source=share')).toBe(
    canonicalUrl('https://www.youtube.com/watch?v=lesson1')
  )
  expect(canonicalUrl('https://www.youtube.com/watch?v=lesson2')).not.toBe(canonicalUrl('https://www.youtube.com/watch?v=lesson1'))
})
