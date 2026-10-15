import { describe, expect, it } from 'vitest'
import { ftsQuery, exactTerms, shortTerms } from '../fts'

describe('规范化、精确词和两字词', () => {
  it('关键词先处理部首与全角字母数字', () => {
    expect(ftsQuery('⼈工智能 ＡＢＣ１２３')).toBe('"人工智" OR "工智能" OR "abc123"')
  })
  it('不同引号和书名号都能提取精确词并去重', () => {
    expect(exactTerms('「冷却装置」『标定数据』“双层输送” "input signal" 《合成说明》')).toEqual([
      '冷却装置',
      '标定数据',
      '双层输送',
      'input signal',
      '合成说明'
    ])
    expect(exactTerms('"冷却装置" 「冷却装置」')).toEqual(['冷却装置'])
  })
  it('允许数字编码、连字符、斜杠、点和标准编号空格', () => {
    expect(exactTerms('DX-2046-041 A_12.3/XY DX/T 2046')).toEqual(['DX-2046-041', 'A_12.3/XY', 'DX/T 2046'])
  })
  it('不收短编码与无数字普通英文，最多五个精确词', () => {
    expect(exactTerms('abc A12 单字 "甲"')).toEqual([])
    expect(exactTerms('"甲乙" "丙丁" "戊己" "庚辛" "壬癸" "子丑"')).toHaveLength(5)
  })
  it('两字整段与虚词拆分的两字片段', () => {
    expect(shortTerms('冷却 温度是多少 气压呢 精度和承重')).toEqual(['冷却', '温度', '气压', '精度', '承重'])
  })
  it('包含停用字的两字片段不使用，最多六个', () => {
    expect(shortTerms('什么 这个 那么')).toEqual([])
    expect(shortTerms('冷却 温度 气压 精度 承重 维护 运行')).toHaveLength(6)
  })
})
