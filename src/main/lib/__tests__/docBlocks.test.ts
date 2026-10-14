import { describe, expect, it } from 'vitest'
import { headingLevel } from '../docBlocks'

describe('编号标题与条款正文', () => {
  it.each([
    ['第一编 总则', 1],
    ['第二部分 试验', 1],
    ['第十二章 系统要求', 1],
    ['第3节 维护', 2],
    ['第十五条 附加约定', 3],
    ['一、总体安排', 1],
    ['（二）准备', 2],
    ['(三) 校验', 2],
    ['1. 合成参数', 1],
    ['2、运行检查', 1],
    ['3 工装准备', 1],
    ['2.3加工需求', 2],
    ['2.3.1输入条件', 3],
    ['2.3.1.1异常处理', 4],
    ['附件A 试验', 1],
    ['附录二 参考', 1],
    ['Chapter 7 Results', 1],
    ['2 Introduction', 1],
    ['2.1 Methods', 2],
    ['  2.1 Methods  ', 2]
  ])('%s 的层级为 %s', (line, level) => {
    expect(headingLevel(line as string)).toBe(level)
  })
  it.each([
    '2.3.2生产速度：≤18min/件。',
    '1.1检查：测量后记录',
    '第一章说明。',
    '2.1 控制要求；',
    '第二章 ....... 12',
    '第一节 … 8',
    '普通正文',
    '1 plain body',
    '',
    '1. ' + '合成标题'.repeat(20)
  ])('正文或目录不算标题：%s', (line) => {
    expect(headingLevel(line)).toBeNull()
  })
})
