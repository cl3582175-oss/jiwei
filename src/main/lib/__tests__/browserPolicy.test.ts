import { describe, expect, it } from 'vitest'
import { canonicalUrl, isSensitiveUrl } from '../browserPolicy'

describe('browser policy', () => {
  it('turns AI off on banking, payment, mail and login pages', () => {
    expect(isSensitiveUrl('https://perbank.abchina.com/EbankSite/startup.do')).toBe(true)
    expect(isSensitiveUrl('https://www.alipay.com/')).toBe(true)
    expect(isSensitiveUrl('https://mail.qq.com/cgi-bin/frame_html')).toBe(true)
    expect(isSensitiveUrl('https://accounts.google.com/signin')).toBe(true)
    expect(isSensitiveUrl('https://passport.bilibili.com/login')).toBe(true)
    expect(isSensitiveUrl('https://netbank.example.com/')).toBe(true)
  })

  it('keeps ordinary learning sites on', () => {
    expect(isSensitiveUrl('https://www.bilibili.com/video/BV1xx')).toBe(false)
    expect(isSensitiveUrl('https://zh.wikipedia.org/wiki/边际效用')).toBe(false)
    expect(isSensitiveUrl('https://www.icourse163.org/learn/PKU')).toBe(false)
    expect(isSensitiveUrl('about:blank')).toBe(false)
  })

  it('applies the user list by domain suffix', () => {
    expect(isSensitiveUrl('https://wiki.company.cn/page', ['company.cn'])).toBe(true)
    expect(isSensitiveUrl('https://notcompany.cn/', ['company.cn'])).toBe(false)
  })

  it('canonical URL drops fragments and tracking parameters', () => {
    expect(canonicalUrl('https://a.com/p?id=1&utm_source=x&spm=2#top')).toBe('https://a.com/p?id=1')
  })
})
