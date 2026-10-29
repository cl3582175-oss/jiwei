import { describe, expect, it } from 'vitest'
import { AiSettingsSchema, ChatSendSchema, EffortSchema } from '../schemas'
import { normalizeEffort, resolveModelPolicy, type Effort, type ProviderKind } from '../ai'

const official = { kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1', sendEffort: true }
const policy = (model: string, overrides: Partial<typeof official> = {}) => resolveModelPolicy({ ...official, ...overrides }, model)

describe('effort input contract', () => {
  it.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'openai-max'])(
    'accepts %s in settings and a real chat input',
    (effort) => {
      expect(EffortSchema.safeParse(effort).success).toBe(true)
      expect(
        AiSettingsSchema.safeParse({
          chat: { providerId: null, model: null },
          effort,
          embedding: { mode: 'local', providerId: null, model: null }
        }).success
      ).toBe(true)
      expect(
        ChatSendSchema.safeParse({ conversationId: null, providerId: 'test', model: 'gpt-6.1-terra', text: 'Hello', effort }).success
      ).toBe(true)
    }
  )
  it.each([null, 'none', 'extreme', ''])('rejects unsupported input %s rather than silently guessing', (effort) => {
    expect(EffortSchema.safeParse(effort).success).toBe(false)
  })
  it.each([undefined, null])('keeps chat effort required and non-null: %s', (effort) => {
    expect(
      ChatSendSchema.safeParse({ conversationId: null, providerId: 'test', model: 'gpt-6.1-terra', text: 'Hello', effort }).success
    ).toBe(false)
  })
})

describe('official model policies', () => {
  it.each([
    ['gpt-6.1-terra', 'openai-responses', ['off', 'low', 'medium', 'high', 'xhigh', 'openai-max']],
    ['gpt-6-astra', 'openai-responses', ['low', 'medium', 'high', 'xhigh', 'openai-max']],
    ['gpt-6.1-sol', 'openai-responses', ['low', 'medium', 'high', 'xhigh', 'openai-max']],
    ['gpt-6-sol', 'openai-responses', ['off', 'low', 'medium', 'high', 'xhigh', 'openai-max']],
    ['gpt-6-luna', 'openai-responses', ['off', 'low', 'medium', 'high', 'xhigh', 'openai-max']],
    ['gpt-5.6-sol', 'openai-chat', ['off', 'low', 'medium', 'high', 'xhigh', 'openai-max']],
    ['gpt-5.6-terra', 'openai-chat', ['off', 'low', 'medium', 'high', 'xhigh', 'openai-max']],
    ['gpt-5.6-luna', 'openai-chat', ['off', 'low', 'medium', 'high', 'xhigh', 'openai-max']],
    ['gpt-5.5', 'openai-chat', ['off', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.4', 'openai-chat', ['off', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.2', 'openai-chat', ['off', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.1', 'openai-chat', ['off', 'low', 'medium', 'high']],
    ['gpt-5', 'openai-chat', ['minimal', 'low', 'medium', 'high']],
    ['gpt-5-pro', 'openai-responses', ['high']]
  ])('%s only exposes its confirmed levels', (model, api, efforts) => {
    expect(policy(model)).toMatchObject({ api, efforts, effortStatus: 'enabled' })
  })
  it.each([
    'gpt-5-2025-08-07',
    'gpt-5.1-2025-11-13',
    'gpt-5.2-2025-12-11',
    'gpt-5.4-2026-03-05',
    'gpt-5.5-2026-04-23',
    'gpt-5-pro-2025-10-06'
  ])('recognizes the documented snapshot %s', (model) => {
    expect(policy(model).effortStatus).toBe('enabled')
  })
  it.each(['gpt-6.1-terra-2099-01-01', 'gpt-7-new', 'gpt-5.5-pro', 'gpt-5-custom'])('does not guess the capabilities of %s', (model) => {
    const p = policy(model)
    expect(p).toMatchObject({ api: 'openai-chat', efforts: [], effortStatus: 'unknown' })
    expect(normalizeEffort(p, 'high')).toBeNull()
  })
  it.each(['gpt-4o', 'gpt-4o-mini'])('does not send reasoning for %s', (model) => {
    expect(policy(model)).toMatchObject({ api: 'openai-chat', efforts: [], effortStatus: 'unsupported' })
    expect(normalizeEffort(policy(model), 'high')).toBeNull()
  })
  it('respects disabled effort and an unselected model', () => {
    expect(policy('gpt-6.1-terra', { sendEffort: false })).toMatchObject({ efforts: [], effortStatus: 'disabled' })
    expect(normalizeEffort(policy('gpt-6.1-terra', { sendEffort: false }), 'openai-max')).toBeNull()
    expect(resolveModelPolicy(official, null)).toMatchObject({ efforts: [], effortStatus: 'unknown' })
  })
})

describe('endpoint identity and legacy providers', () => {
  it('recognizes a custom configuration pointing at the official endpoint', () => {
    expect(resolveModelPolicy({ ...official, kind: 'custom', baseUrl: 'https://api.openai.com/v1/' }, 'gpt-6.1-terra').api).toBe(
      'openai-responses'
    )
  })
  it.each([
    'http://api.openai.com/v1',
    'https://api.openai.com.evil.example/v1',
    'https://api.openai.com:444/v1',
    'https://name@api.openai.com/v1',
    'https://api.openai.com/v1?x=1',
    'https://api.openai.com/v1/responses',
    'not a URL',
    'https://proxy.example/v1'
  ])('preserves the compatible protocol for %s', (baseUrl) => {
    expect(resolveModelPolicy({ ...official, baseUrl }, 'gpt-6.1-terra').api).toBe('openai-compatible')
  })
  it.each<ProviderKind>(['deepseek', 'qwen', 'moonshot', 'zhipu', 'ollama', 'custom'])(
    'preserves %s levels even for a GPT model name',
    (kind) => {
      const p = resolveModelPolicy({ kind, baseUrl: 'https://provider.example/v1', sendEffort: true }, 'gpt-6.1-terra')
      expect(p.api).toBe('openai-compatible')
      expect(p.efforts).not.toContain('openai-max')
      expect(p.efforts).not.toContain('xhigh')
    }
  )
  it.each<ProviderKind>(['anthropic', 'google'])('does not reinterpret sendEffort for %s', (kind) => {
    const p = resolveModelPolicy({ kind, baseUrl: 'https://provider.example/v1', sendEffort: false }, 'model')
    expect(p.effortStatus).toBe('enabled')
    expect(normalizeEffort(p, 'high')).toBe('high')
  })
})

describe('normalization preserves intent and old max cost', () => {
  it.each([
    ['gpt-6.1-terra', 'off', 'off'],
    ['gpt-5', 'off', 'minimal'],
    ['gpt-6-astra', 'off', 'low'],
    ['gpt-6.1-terra', 'minimal', 'low'],
    ['gpt-6.1-terra', 'high', 'high'],
    ['gpt-6.1-terra', 'max', 'high'],
    ['gpt-6.1-terra', 'openai-max', 'openai-max'],
    ['gpt-5.5', 'openai-max', 'xhigh'],
    ['gpt-5.1', 'xhigh', 'high'],
    ['gpt-5-pro', 'off', 'high']
  ])('%s normalizes %s to %s idempotently', (model, input, want) => {
    const p = policy(model)
    const actual = normalizeEffort(p, input as Effort)
    expect(actual).toBe(want)
    expect(normalizeEffort(p, actual!)).toBe(want)
  })
  it('keeps DeepSeek medium→high and carries a new explicit maximum to its old maximum', () => {
    const p = resolveModelPolicy({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com', sendEffort: true }, 'deepseek-flash')
    expect(normalizeEffort(p, 'medium')).toBe('high')
    expect(normalizeEffort(p, 'openai-max')).toBe('max')
    expect(normalizeEffort(p, 'xhigh')).toBe('high')
    expect(normalizeEffort(p, 'minimal')).toBe('low')
  })
})
