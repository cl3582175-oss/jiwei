import { describe, expect, it } from 'vitest'
import { mailBodyText, parseMailPart, selectMailParts, mailBodyFromParts } from '../mailText'

describe('只读邮件正文', () => {
  it('IMAP 根正文 TEXT 以小写键返回时仍正确解码', async () => {
    expect(await mailBodyFromParts([{ type: 'text/plain', encoding: '8bit' }], new Map([['text', Buffer.from('当前邮件正文')]]))).toBe(
      '当前邮件正文'
    )
  })
  it('HTML 转正文并去脚本、引用的历史邮件', () => {
    expect(
      mailBodyText({
        html: '<p>明天学习概率。</p><script>leak()</script><blockquote>旧邮件内容</blockquote><div class="gmail_quote">历史引用</div>'
      })
    ).toBe('明天学习概率。')
  })
  it('纯文本去引用并截断八千字', () => {
    expect(mailBodyText({ text: '新邮件\n> 历史邮件\n\nOn Monday, Teacher wrote:\n旧内容' })).toBe('新邮件')
    expect(mailBodyText({ text: '字'.repeat(9000) })).toHaveLength(8000)
  })
  it('MIME 单正文部分按字符集与转移编码解码', async () => {
    const p = await parseMailPart(Buffer.from('5a2m5Lmg5qaC546H', 'ascii'), { type: 'text/plain', encoding: 'base64', charset: 'utf-8' })
    expect(p).toBe('学习概率')
  })
  it('正文选择不下载 text 附件或嵌入旧邮件', () => {
    const p = selectMailParts({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', part: '1' },
        { type: 'text/plain', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'lesson.txt' }, size: 100 },
        { type: 'message/rfc822', part: '3', childNodes: [{ type: 'text/plain', part: '3.1' }], size: 200 }
      ]
    })
    expect(p.bodies.map((p) => p.part)).toEqual(['1'])
    expect(p.attachments).toEqual([
      { name: 'lesson.txt', size: 100 },
      { name: 'attachment', size: 200 }
    ])
  })
})
