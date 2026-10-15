import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { replyCandidate, quotedMessage } from '../replySelection'

const { document } = parseHTML(
  '<main><div data-reply-id="one" data-conversation-id="chat">正文</div><div data-reply-id="two" data-conversation-id="chat">第二条</div></main>'
)
const one = document.querySelector('[data-reply-id="one"]') as unknown as HTMLElement
const two = document.querySelector('[data-reply-id="two"]') as unknown as HTMLElement

describe('assistant reply selections', () => {
  it('rejects cross-reply, outside and streaming selections', () => {
    expect(replyCandidate(one, two, '跨回复', '', '')).toBeNull()
    expect(replyCandidate(one, null, '跨正文', '', '')).toBeNull()
    one.dataset.streaming = 'true'
    expect(replyCandidate(one, one, '流式', '', '')).toBeNull()
    delete one.dataset.streaming
  })
  it('keeps a message anchor with bounded position context and restricts long or card replies', () => {
    const normal = replyCandidate(one, one, '选中文字', '前'.repeat(180), '后'.repeat(180))!
    expect(normal.anchor).toMatchObject({
      kind: 'text',
      parentType: 'message',
      parentId: 'one',
      ownerId: 'chat',
      quote: '选中文字',
      prefix: '前'.repeat(120),
      suffix: '后'.repeat(120)
    })
    expect(normal.restricted).toBe(false)
    expect(replyCandidate(one, one, '长'.repeat(2001), '', '')!.restricted).toBe(true)
    one.dataset.replyRestricted = 'true'
    expect(replyCandidate(one, one, '短', '', '')!.restricted).toBe(true)
    delete one.dataset.replyRestricted
  })
  it('quotes every selected line without changing the typed follow-up', () => {
    expect(quotedMessage('请解释', '第一行\n第二行')).toBe('> 第一行\n> 第二行\n\n请解释')
    expect(quotedMessage('问题', null)).toBe('问题')
  })
})
