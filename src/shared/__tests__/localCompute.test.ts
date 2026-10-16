import { expect, it } from 'vitest'
import { AiSettingsSchema } from '../schemas'
import { capabilities } from '../capabilities'

const previous = { chat: { providerId: null, model: null }, effort: 'high', embedding: { mode: 'local', providerId: null, model: null } }

it.each(['auto', 'cpu'])('persists the explicit compute choice %s through the actual settings schema', (localCompute) => {
  expect(AiSettingsSchema.parse({ ...previous, localCompute }).localCompute).toBe(localCompute)
})
it('keeps previous settings valid and rejects unsupported provider/backend preferences', () => {
  expect(AiSettingsSchema.safeParse(previous).success).toBe(true)
  expect(AiSettingsSchema.safeParse({ ...previous, localCompute: 'cuda' }).success).toBe(false)
})
it('registers local compute maintenance for the app without exposing downloads/deletion as assistant tools', () => {
  expect(capabilities).toHaveProperty('localCompute.status')
  expect(capabilities).toHaveProperty('localCompute.redetect')
  expect(capabilities).toHaveProperty('localCompute.retryCuda')
  expect(capabilities).toHaveProperty('localCompute.removeCuda')
  for (const entry of Object.values(capabilities.localCompute)) expect(entry.ai).toBeUndefined()
})
