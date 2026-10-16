import { expect, it } from 'vitest'
import { AiSettingsSchema } from '../schemas'

const previous = { chat: { providerId: null, model: null }, effort: 'high', embedding: { mode: 'local', providerId: null, model: null } }

it.each(['auto', 'cpu'])('persists the explicit compute choice %s through the actual settings schema', (localCompute) => {
  expect(AiSettingsSchema.parse({ ...previous, localCompute }).localCompute).toBe(localCompute)
})
it('keeps previous settings valid and rejects unsupported provider/backend preferences', () => {
  expect(AiSettingsSchema.safeParse(previous).success).toBe(true)
  expect(AiSettingsSchema.safeParse({ ...previous, localCompute: 'cuda' }).success).toBe(false)
})
