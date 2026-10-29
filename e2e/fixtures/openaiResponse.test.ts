import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText, tool } from 'ai'
import { z } from 'zod'
import { writeOpenAiCompletion, type OpenAiCompletion } from './openaiResponse'

const servers: Server[] = []
const usage = { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 }
const output = { text: '受控晨报：先处理到期复习。' }
const structured: OpenAiCompletion = {
  id: 'structured-fixture',
  object: 'chat.completion',
  created: 1,
  model: 'transport-fixture',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'submit-1', type: 'function', function: { name: 'submit', arguments: JSON.stringify(output) } }]
    },
    finish_reason: 'tool_calls'
  }],
  usage
}

async function provider(completion: OpenAiCompletion) {
  const requests: { stream?: boolean; tools?: { function: { name: string } }[] }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      const input = JSON.parse(body)
      requests.push(input)
      writeOpenAiCompletion(response, completion, !!input.stream)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  return {
    requests,
    baseURL,
    model: createOpenAICompatible({ name: 'fixture', baseURL })('transport-fixture')
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

it('preserves the complete original JSON response for non-streaming requests', async () => {
  const { baseURL, requests } = await provider(structured)
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [], stream: false })
  })
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(await response.json()).toEqual(structured)
  expect(requests).toHaveLength(1)
  expect(requests[0].stream).toBe(false)
})

it('delivers structured submit arguments, finish reason, and usage through the real SDK stream', async () => {
  const { model, requests } = await provider(structured)
  const result = streamText({
    model,
    prompt: 'Generate the controlled briefing',
    tools: { submit: tool({ inputSchema: z.object({ text: z.string() }) }) },
    toolChoice: { type: 'tool', toolName: 'submit' },
    maxRetries: 0
  })
  await result.consumeStream()
  expect(await result.toolCalls).toMatchObject([{ toolCallId: 'submit-1', toolName: 'submit', input: output }])
  expect(await result.finishReason).toBe('tool-calls')
  expect(await result.usage).toMatchObject({ inputTokens: 100, outputTokens: 80, totalTokens: 180 })
  expect(requests).toHaveLength(1)
  expect(requests[0].stream).toBe(true)
  expect(requests[0].tools?.map((tool) => tool.function.name)).toEqual(['submit'])
})

it('delivers ordinary text, the original finish reason, and usage through the real SDK stream', async () => {
  const completion: OpenAiCompletion = {
    ...structured,
    id: 'text-fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: '先处理逾期的行动项。' }, finish_reason: 'length' }]
  }
  const { model, requests } = await provider(completion)
  const result = streamText({ model, prompt: 'Give one suggestion', maxRetries: 0 })
  await result.consumeStream()
  expect(await result.text).toBe('先处理逾期的行动项。')
  expect(await result.toolCalls).toEqual([])
  expect(await result.finishReason).toBe('length')
  expect(await result.usage).toMatchObject({ inputTokens: 100, outputTokens: 80, totalTokens: 180 })
  expect(requests[0].stream).toBe(true)
})
