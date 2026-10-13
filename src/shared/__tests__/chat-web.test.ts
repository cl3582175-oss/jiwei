import { describe, expect, it } from 'vitest'
import { ChatSendSchema } from '../schemas'
import { capabilities } from '../capabilities'

const base = {
  conversationId: null,
  text: 'Controlled question',
  providerId: 'fixture',
  model: 'fixture',
  effort: 'off',
  scope: { type: 'none' }
}
describe('conversation web input contracts', () => {
  it.each(['off', 'auto', 'always'])('retains a %s send mode with no knowledge base', (web) => {
    expect(ChatSendSchema.parse({ ...base, web })).toMatchObject({ web, scope: { type: 'none' } })
  })
  it('rejects invalid web modes and null on send', () => {
    for (const web of ['invalid', null, true]) expect(ChatSendSchema.safeParse({ ...base, web }).success).toBe(false)
    expect(ChatSendSchema.safeParse(base).success).toBe(true)
  })
  it('retains nullable web updates to return to the global default', () => {
    const patch = capabilities.chat.update.params[1][1]
    for (const web of ['off', 'auto', 'always', null]) expect(patch.parse({ web })).toEqual({ web })
    expect(patch.safeParse({ web: 'invalid' }).success).toBe(false)
  })
})
