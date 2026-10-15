import { describe, expect, it } from 'vitest'
import { normalizeExtracted, normalizeQuery } from '../textNormalize'

describe('只修正文字提取产物', () => {
  it('康熙部首和明确规定的补充部首样例', () => {
    expect(normalizeExtracted('⼈⽆⻛⾦')).toBe('人无风金')
  })
  it('兼容汉字含补充平面归一化', () => {
    expect(normalizeExtracted('神\u{2f800}')).toBe('神丽')
  })
  it('全角数字字母归一，标点不动', () => {
    expect(normalizeExtracted('有限责任（Ｌｔｄ）２０２１年')).toBe('有限责任（Ltd）2021年')
  })
  it('零宽删除，但作者空白保留，NBSP变成空格', () => {
    expect(normalizeExtracted('甲\u200b乙\u200c丙\u200d丁\ufeff\u00a0戊\u2002\u200a\u3000己')).toBe('甲乙丙丁 戊\u2002\u200a\u3000己')
  })
  it.each(['', '普通中文，繁體仍為繁體。', 'Alpha β ≤ 0.05 😀🌿', 'const value = a !== 2; // 中文注释'])('不改正常文本 %s', (s) => {
    expect(normalizeExtracted(s)).toBe(s)
  })
  it('检索入口额外统一空白，保持大小写和标点', () => {
    expect(normalizeQuery(' \t⼈\u3000Ａ\n B（甲） ')).toBe('人 A B（甲）')
  })
})
