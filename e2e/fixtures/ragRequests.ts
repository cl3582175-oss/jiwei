import type { ElectronApplication } from '@playwright/test'

export interface RagRequest {
  model: string
  messages: { role: string; content: unknown }[]
  toolNames: string[]
}
/** 只采集模型正文以核对两组证据；不读取地址、headers、密钥或请求的其它字段。 */
export async function captureRagRequests(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ net }) => {
    const state = globalThis as unknown as { ragEvalRequests: RagRequest[] }
    state.ragEvalRequests = []
    const original = net.fetch.bind(net)
    net.fetch = (input, init) => {
      if (typeof init?.body === 'string') {
        try {
          const body = JSON.parse(init.body) as {
            model?: string
            messages?: RagRequest['messages']
            tools?: { function?: { name?: string } }[]
          }
          if (Array.isArray(body.messages))
            state.ragEvalRequests.push({
              model: body.model ?? '',
              messages: body.messages,
              toolNames: (body.tools ?? []).flatMap((t) => (t.function?.name ? [t.function.name] : []))
            })
        } catch {
          /* 不是聊天 JSON */
        }
      }
      return original(input, init)
    }
  })
}
export async function takeRagRequests(app: ElectronApplication): Promise<RagRequest[]> {
  return app.evaluate(() => {
    const state = globalThis as unknown as { ragEvalRequests: RagRequest[] }
    const rows = state.ragEvalRequests
    state.ragEvalRequests = []
    return rows
  })
}
export function initialEvidence(requests: RagRequest[]): string {
  const first = requests[0]
  const user = first?.messages.filter((m) => m.role === 'user').at(-1)?.content
  const text = typeof user === 'string' ? user : JSON.stringify(user)
  return text?.match(/<知识库片段>\n([\s\S]*?)\n<\/知识库片段>/)?.[1] ?? ''
}
