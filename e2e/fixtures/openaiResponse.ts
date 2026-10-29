import type { ServerResponse } from 'node:http'

export interface OpenAiCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: {
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
    finish_reason: string | null
  }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/** Controlled providers must match the transport requested by the real SDK. */
export function writeOpenAiCompletion(response: ServerResponse, completion: OpenAiCompletion, streaming: boolean): void {
  if (!streaming) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(completion))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const metadata = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model }
  const chunk = (data: object): void => { response.write(`data: ${JSON.stringify({ ...metadata, ...data })}\n\n`) }
  chunk({
    choices: completion.choices.map(({ index, message }) => ({
      index,
      delta: {
        ...message,
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {})
      },
      finish_reason: null
    }))
  })
  chunk({ choices: completion.choices.map(({ index, finish_reason }) => ({ index, delta: {}, finish_reason })) })
  if (completion.usage) chunk({ choices: [], usage: completion.usage })
  response.end('data: [DONE]\n\n')
}
