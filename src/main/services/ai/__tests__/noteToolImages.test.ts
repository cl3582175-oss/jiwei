import { expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { attachNoteToolImages } from '../noteToolImages'
it('sends tool image bytes as user image parts rather than JSON text to compatible providers', () => {
  const messages: ModelMessage[] = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'i',
          toolName: 'note_image_view',
          output: { type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } }] }
        }
      ]
    }
  ]
  const result = attachNoteToolImages(messages)
  expect(result[0]).toMatchObject({ role: 'tool', content: [{ output: { type: 'text' } }] })
  expect(result[1]).toEqual({ role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,AQID' }] })
  expect(messages[0]).toMatchObject({ content: [{ output: { type: 'content' } }] })
})
it('preserves failed tool results and other tools without adding image messages', () => {
  const messages: ModelMessage[] = [
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'i', toolName: 'note_image_view', output: { type: 'error-text', value: 'excluded' } }]
    }
  ]
  expect(attachNoteToolImages(messages)).toEqual(messages)
})
