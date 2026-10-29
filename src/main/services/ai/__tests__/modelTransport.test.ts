import { beforeEach, expect, it, vi } from 'vitest'
import { generateText, streamText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import type { Effort, ProviderKind } from '@shared/ai'
const f = vi.hoisted(() => ({
  row: { kind: 'openai' as ProviderKind, name: 'Synthetic', baseUrl: 'http://127.0.0.1/v1', sendEffort: false },
  budget: vi.fn(),
  usage: vi.fn(),
  fallback: vi.fn(async () => {
    throw new Error('Unexpected unguarded transport')
  })
}))
vi.mock('electron', () => ({ net: { fetch: f.fallback } }))
vi.mock('../providers', () => ({
  getProviderRow: () => f.row,
  decryptKey: () => 'synthetic-test-key'
}))
vi.mock('../../agent/usage', () => ({ checkBudget: f.budget, recordUsage: f.usage }))
vi.mock('../../agent/context', () => ({ currentRun: () => null }))
import { buildModel } from '../model'
beforeEach(() => {
  vi.clearAllMocks()
  f.row = { kind: 'openai', name: 'Synthetic', baseUrl: 'http://127.0.0.1/v1', sendEffort: false }
})
it('passes a per-request guarded transport into the provider SDK', async () => {
  const transport = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 1,
          model: 'vision',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Transport result' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  )
  const model = buildModel({ providerId: 'test', model: 'vision', effort: 'off', fetch: transport })
  const result = await generateText({ model: model.model, maxRetries: 0, prompt: 'Transport test' })
  expect(result.text).toBe('Transport result')
  expect(transport).toHaveBeenCalledTimes(1)
  expect(f.fallback).not.toHaveBeenCalled()
})

const responseUsage = {
  input_tokens: 10,
  output_tokens: 3,
  total_tokens: 13,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens_details: { reasoning_tokens: 1 }
}
const message = {
  type: 'message',
  id: 'msg_test',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Transport result', annotations: [] }]
}
function response(output: unknown[] = [message]) {
  return { id: 'resp_test', object: 'response', created_at: 1, model: 'gpt-6.1-terra', status: 'completed', output, usage: responseUsage }
}
function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}
function chatResponse() {
  return {
    id: 'chat_test',
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Transport result' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
  }
}
function controlledTransport() {
  const requests: { url: string; body: Record<string, unknown> }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    init?.signal?.throwIfAborted()
    const url = String(input)
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    return jsonResponse(url.endsWith('/responses') ? response() : chatResponse())
  }
  return { requests, fetch }
}
const official = () => {
  f.row = { ...f.row, baseUrl: 'https://api.openai.com/v1', sendEffort: true }
}

it.each([
  ['gpt-6.1-terra', 'off', 'none', 8192],
  ['gpt-6.1-terra', 'low', 'low', 32768],
  ['gpt-6.1-terra', 'medium', 'medium', 32768],
  ['gpt-6.1-terra', 'high', 'high', 32768],
  ['gpt-6.1-terra', 'xhigh', 'xhigh', 32768],
  ['gpt-6.1-terra', 'openai-max', 'max', 65536],
  ['gpt-6.1-terra', 'max', 'high', 32768],
  ['gpt-6-astra', 'off', 'low', 32768],
  ['gpt-6.1-sol', 'minimal', 'low', 32768],
  ['gpt-6-sol', 'off', 'none', 8192],
  ['gpt-6-luna', 'xhigh', 'xhigh', 32768],
  ['gpt-5-pro', 'off', 'high', 32768]
])('uses native Responses for %s/%s without storage or an implicit summary', async (model, effort, wire, budget) => {
  official()
  const t = controlledTransport()
  const built = buildModel({ providerId: 'test', model: String(model), effort: effort as Effort, fetch: t.fetch })
  expect(t.requests).toHaveLength(0)
  const r = await generateText({
    model: built.model,
    providerOptions: built.providerOptions,
    maxOutputTokens: built.maxOutputTokens,
    maxRetries: 0,
    prompt: 'Public test'
  })
  expect(r.text).toBe('Transport result')
  expect(t.requests).toHaveLength(1)
  expect(t.requests[0].url).toBe('https://api.openai.com/v1/responses')
  expect(t.requests[0].body).toMatchObject({ max_output_tokens: budget, store: false, reasoning: { effort: wire } })
  expect(t.requests[0].body).not.toHaveProperty('max_tokens')
  expect(t.requests[0].body).not.toHaveProperty('max_completion_tokens')
  expect(t.requests[0].body.reasoning).not.toHaveProperty('summary')
  expect(f.usage).toHaveBeenCalledWith(
    'test',
    model,
    { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 1 },
    null,
    expect.any(Number)
  )
})

it.each([
  ['gpt-5.6-terra', 'openai-max', 'max'],
  ['gpt-5.6-sol', 'off', 'none'],
  ['gpt-5.6-luna', 'xhigh', 'xhigh'],
  ['gpt-5.5', 'xhigh', 'xhigh'],
  ['gpt-5.4', 'off', 'none'],
  ['gpt-5.2', 'medium', 'medium'],
  ['gpt-5.1', 'off', 'none'],
  ['gpt-5', 'off', 'minimal'],
  ['gpt-5-2025-08-07', 'minimal', 'minimal'],
  ['gpt-4o', 'high', null],
  ['unknown-model', 'high', null]
])('lets the native Chat SDK serialize %s/%s', async (model, effort, wire) => {
  official()
  const t = controlledTransport()
  const built = buildModel({ providerId: 'test', model: String(model), effort: effort as Effort, fetch: t.fetch })
  await generateText({
    model: built.model,
    providerOptions: built.providerOptions,
    maxOutputTokens: built.maxOutputTokens,
    maxRetries: 0,
    prompt: 'Public test'
  })
  expect(t.requests[0].url).toBe('https://api.openai.com/v1/chat/completions')
  const body = t.requests[0].body
  expect(body).toHaveProperty(String(model).startsWith('gpt-5') ? 'max_completion_tokens' : 'max_tokens')
  expect(body).not.toHaveProperty(String(model).startsWith('gpt-5') ? 'max_tokens' : 'max_completion_tokens')
  if (wire) expect(body.reasoning_effort).toBe(wire)
  else expect(body).not.toHaveProperty('reasoning_effort')
})

it('disables explicit effort without injecting a default summary', async () => {
  official()
  f.row.sendEffort = false
  const t = controlledTransport()
  const built = buildModel({ providerId: 'test', model: 'gpt-6.1-terra', effort: 'openai-max', fetch: t.fetch })
  expect(built.effectiveEffort).toBeNull()
  await generateText({ model: built.model, providerOptions: built.providerOptions, maxRetries: 0, prompt: 'Public test' })
  expect(t.requests[0].body.store).toBe(false)
  expect(t.requests[0].body.reasoning ?? {}).not.toHaveProperty('effort')
  expect(t.requests[0].body.reasoning ?? {}).not.toHaveProperty('summary')
})

it.each(['openai', 'custom', 'deepseek', 'qwen'] as const)('keeps %s proxies on their existing compatible protocol', async (kind) => {
  f.row = { ...f.row, kind, baseUrl: 'https://proxy.example/v1', sendEffort: true }
  const t = controlledTransport()
  const built = buildModel({ providerId: 'test', model: 'gpt-6.1-terra', effort: 'high', fetch: t.fetch })
  await generateText({
    model: built.model,
    providerOptions: built.providerOptions,
    maxOutputTokens: built.maxOutputTokens,
    maxRetries: 0,
    prompt: 'Public test'
  })
  expect(t.requests[0].url).toBe('https://proxy.example/v1/chat/completions')
  expect(t.requests[0].body.max_tokens).toBe(32768)
  expect(t.requests[0].body).not.toHaveProperty('store')
  if (kind === 'qwen') expect(t.requests[0].body).toMatchObject({ enable_thinking: true, thinking_budget: 16384 })
  else expect(t.requests[0].body.reasoning_effort).toBe('high')
})

it('recognizes custom official configuration without rewriting the configured URL', async () => {
  official()
  f.row.kind = 'custom'
  f.row.baseUrl += '/'
  const t = controlledTransport()
  const built = buildModel({ providerId: 'test', model: 'gpt-6.1-terra', effort: 'high', fetch: t.fetch })
  await generateText({ model: built.model, providerOptions: built.providerOptions, maxRetries: 0, prompt: 'Public test' })
  expect(t.requests[0].url).toBe('https://api.openai.com/v1/responses')
})

function sse(events: unknown[]) {
  return new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
    headers: { 'content-type': 'text/event-stream' }
  })
}
function textEvents() {
  return [
    { type: 'response.created', response: response() },
    { type: 'response.output_item.added', output_index: 0, item: message },
    { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: 'Transport result' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: response() }
  ]
}
it('consumes native Responses SSE and meters the provider usage', async () => {
  official()
  let body: Record<string, unknown> = {}
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return sse(textEvents())
  }
  const built = buildModel({ providerId: 'test', model: 'gpt-6.1-terra', effort: 'off', fetch })
  const r = streamText({
    model: built.model,
    providerOptions: built.providerOptions,
    maxOutputTokens: built.maxOutputTokens,
    maxRetries: 0,
    prompt: 'Public test'
  })
  expect(await r.text).toBe('Transport result')
  expect(body).toMatchObject({ stream: true, max_output_tokens: 8192, store: false, reasoning: { effort: 'none' } })
  expect(f.budget).toHaveBeenCalledTimes(1)
  expect(f.usage).toHaveBeenCalledTimes(1)
})

it('retains full tool and encrypted reasoning data on the second stateless Responses turn', async () => {
  official()
  const requests: Record<string, unknown>[] = []
  const reasoning = { type: 'reasoning', id: 'rs_test', encrypted_content: 'synthetic-encrypted-context', summary: [] }
  const call = {
    type: 'function_call',
    id: 'fc_test',
    call_id: 'call_test',
    name: 'lookup',
    arguments: '{"topic":"public"}',
    status: 'completed'
  }
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return requests.length === 1
      ? sse([
          { type: 'response.created', response: response([]) },
          { type: 'response.output_item.added', output_index: 0, item: reasoning },
          { type: 'response.output_item.done', output_index: 0, item: reasoning },
          { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_test', output_index: 1, delta: call.arguments },
          { type: 'response.output_item.done', output_index: 1, item: call },
          { type: 'response.completed', response: response([reasoning, call]) }
        ])
      : sse(textEvents())
  }
  const built = buildModel({ providerId: 'test', model: 'gpt-6.1-terra', effort: 'high', fetch })
  const guard = vi.fn()
  const r = streamText({
    model: built.model,
    providerOptions: built.providerOptions,
    maxRetries: 0,
    prompt: 'Public test',
    stopWhen: stepCountIs(2),
    prepareStep: () => {
      guard()
      return {}
    },
    tools: { lookup: tool({ inputSchema: z.object({ topic: z.string() }), execute: async () => 'public-result' }) }
  })
  expect(await r.text).toBe('Transport result')
  expect(requests).toHaveLength(2)
  expect(requests[1].input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', encrypted_content: 'synthetic-encrypted-context' }),
      expect.objectContaining({ type: 'function_call', call_id: 'call_test', arguments: '{"topic":"public"}' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_test', output: 'public-result' })
    ])
  )
  expect((requests[1].input as { type: string }[]).some((i) => i.type === 'item_reference')).toBe(false)
  expect(guard).toHaveBeenCalledTimes(2)
  expect(f.budget).toHaveBeenCalledTimes(2)
  expect(f.usage).toHaveBeenCalledTimes(2)
})

it('checks the budget at execution rather than construction and blocks transport when exhausted', async () => {
  official()
  const t = controlledTransport()
  const built = buildModel({ providerId: 'test', model: 'gpt-6.1-terra', effort: 'high', fetch: t.fetch })
  expect(f.budget).not.toHaveBeenCalled()
  f.budget.mockImplementationOnce(() => {
    throw new Error('Controlled budget exhausted')
  })
  await expect(
    generateText({ model: built.model, providerOptions: built.providerOptions, prompt: 'Public test', maxRetries: 0 })
  ).rejects.toThrow('Controlled budget exhausted')
  expect(t.requests).toHaveLength(0)
  expect(f.usage).not.toHaveBeenCalled()
})

it('does not send an already aborted native request', async () => {
  official()
  const t = controlledTransport()
  const built = buildModel({ providerId: 'test', model: 'gpt-6.1-terra', effort: 'high', fetch: t.fetch })
  const controller = new AbortController()
  controller.abort(new Error('Controlled cancellation'))
  await expect(
    generateText({
      model: built.model,
      providerOptions: built.providerOptions,
      prompt: 'Public test',
      abortSignal: controller.signal,
      maxRetries: 0
    })
  ).rejects.toThrow('Controlled cancellation')
  expect(t.requests).toHaveLength(0)
  expect(f.usage).not.toHaveBeenCalled()
})
