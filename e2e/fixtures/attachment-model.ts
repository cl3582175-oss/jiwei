import { createServer, type Server } from 'node:http'

export interface ModelRequest {
  messages: { role: string; content: unknown }[]
  tools?: { function: { name: string; parameters?: Record<string, unknown> } }[]
  stream?: boolean
  max_tokens?: number
}
export const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : Array.isArray(value) ? value.map((part) => part.text ?? '').join('') : ''
export async function attachmentModel(options: { embeddingDimensions?: number; chunkDelayMs?: number; reasoning?: string } = {}): Promise<{
  server: Server
  url: string
  requests: ModelRequest[]
  setAnswer(text: string): void
  tool(name: string, input: unknown): void
}> {
  const requests: ModelRequest[] = []
  let answer = '已根据提供的内容回答。',
    next: { name: string; input: unknown } | null = null
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/feed') {
      const port = (server.address() as { port: number }).port
      res
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          `<rss version="2.0"><channel><title>Controlled feed</title><link>http://127.0.0.1:${port}/article</link><description>Fixture</description><item><guid>controlled-evidence</guid><title>Learning evidence</title><link>http://127.0.0.1:${port}/article</link><description>Practice with controlled source evidence</description></item></channel></rss>`
        )
      return
    }

    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', async () => {
      const input = JSON.parse(body || '{}') as ModelRequest
      requests.push(input)
      if (req.url?.endsWith('/embeddings')) {
        const rows = (input as ModelRequest & { input: string[] }).input
        const size = options.embeddingDimensions ?? 512
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ data: rows.map((_, index) => ({ index, embedding: [1, ...Array(size - 1).fill(0)] })) }))
        return
      }

      // 本地受控的普通非流式调用（例如识别）也遵循同一真实协议。
      if (!input.stream && !input.tools?.length) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'controlled-plain',
            object: 'chat.completion',
            created: 1,
            model: 'controlled',
            choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
          })
        )
        return
      }
      const submit = input.tools?.find((t) => t.function.name === 'submit')
      const properties = (submit?.function.parameters?.properties ?? {}) as Record<string, unknown>
      const segmentId =
        /\[([a-z0-9-]{16,})/.exec(
          input.messages
            .filter((m) => m.role === 'user')
            .map((m) => textOf(m.content))
            .join('\n')
        )?.[1] ?? ''
      const output =
        'points' in properties
          ? { topic: '受控主题', points: [{ text: '摘要稳定事实', segmentId }] }
          : 'markdown' in properties
            ? { markdown: answer }
            : 'restated' in properties
              ? {
                  restated: answer.slice(0, 250),
                  options: [
                    { id: 'O1', title: '方案一', summary: '结合所供资料' },
                    { id: 'O2', title: '方案二', summary: '继续收集信息' }
                  ],
                  criteria: [
                    { name: '收益', weight: 3, why: '' },
                    { name: '成本', weight: 3, why: '' }
                  ],
                  scores: [],
                  evidence: [],
                  assumptions: [],
                  premortem: [],
                  secondOrder: [],
                  counter: '',
                  risks: [],
                  recommendation: { option: 'O1', why: '根据所供资料分析' },
                  confidence: 3,
                  unknowns: []
                }
              : 'memories' in properties
                ? { memories: [], concepts: [], episode: null }
                : 'picks' in properties
                  ? { picks: [] }
                  : 'items' in properties
                    ? { items: [] }
                    : { picks: [], items: [], memories: [], concepts: [], episode: null }
      if (!input.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'controlled-structured',
            object: 'chat.completion',
            created: 1,
            model: 'attachments-controlled',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'submit', type: 'function', function: { name: 'submit', arguments: JSON.stringify(output) } }]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
          })
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: unknown, finish: string | null): void => {
        res.write(
          `data: ${JSON.stringify({ id: 'controlled-attachments', object: 'chat.completion.chunk', created: 1, model: 'attachments-controlled', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      }
      if (submit) {
        send(
          {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit', arguments: JSON.stringify(output) } }]
          },
          null
        )
        send({}, 'tool_calls')
      } else if (next) {
        const tool = next
        next = null
        send(
          {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: 'attachment-tool', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }
            ]
          },
          null
        )
        send({}, 'tool_calls')
      } else {
        if (options.reasoning) send({ reasoning_content: options.reasoning }, null)
        const system = textOf(input.messages.find((m) => m.role === 'system')?.content)
        const response = /第一行.*#|first line.*#/i.test(system) ? `# 受控主题\n- 摘要稳定事实 {${segmentId}}` : answer
        for (let i = 0; i < response.length; i += 12) {
          if (options.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, options.chunkDelayMs))
          send({ content: response.slice(i, i + 12) }, null)
        }
        send({}, 'stop')
      }
      res.write(
        `data: ${JSON.stringify({ id: 'controlled-attachments', object: 'chat.completion.chunk', created: 1, model: 'attachments-controlled', choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`
      )
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    setAnswer: (text) => {
      answer = text
    },
    tool: (name, input) => {
      next = { name, input }
    }
  }
}
