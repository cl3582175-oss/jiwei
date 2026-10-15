import type { ElectronApplication } from '@playwright/test'
import type { ChatMessage } from '../../src/shared/types'

export interface RagRequest {
  model: string
  messages: { role: string; content: unknown }[]
  toolNames: string[]
}
/** 只采集模型正文以核对两组证据；不读取地址、headers、密钥或请求的其它字段。 */
export async function captureRagRequests(app: ElectronApplication, excludedModel?: string): Promise<void> {
  await app.evaluate(({ net }, excludedModel) => {
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
          if (Array.isArray(body.messages) && (!excludedModel || body.model !== excludedModel))
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
  }, excludedModel)
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
  return text?.match(/<(?:知识库片段|excerpts)>\n([\s\S]*?)\n<\/(?:知识库片段|excerpts)>/)?.[1] ?? ''
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n')
  if (content && typeof content === 'object') {
    const part = content as { type?: string; text?: unknown; content?: unknown }
    if (typeof part.text === 'string') return part.text
    if (part.type === 'tool_result') return contentText(part.content)
  }
  return ''
}
function numberedParts(text: string) {
  const headers = [...text.matchAll(/^\[(\d+)\] (?:资料《|笔记《|Source "|Note《)[^\r\n]*(?:sourceId|noteId):[^\r\n]*/gm)]
  return headers.flatMap((match, i) => {
    const header = match[0],
      parent = /(?:sourceId|noteId):\s*([^\s）)]+)/.exec(header)?.[1]
    if (!parent) return []
    const parentType = header.includes('sourceId:') ? 'source' : 'note'
    return [
      {
        number: Number(match[1]),
        header,
        parentType,
        parentId: parent,
        ownerId: parentType === 'source' ? /(?:片段|segment)\s+(\S+)/.exec(header)?.[1] : undefined,
        text: text
          .slice(match.index! + header.length, headers[i + 1]?.index ?? text.length)
          .replace(/\n<\/external-data>\s*$/, '')
          .trim()
      }
    ]
  })
}

/** 只采用实际请求里的user证据和tool结果，绝不把assistant复述或未发送的数据库段当来源。 */
export function nativeJudgeEvidence(answer: ChatMessage, requests: RagRequest[], reference: unknown) {
  const materials: string[] = [],
    observations: string[] = []
  for (const request of requests) {
    const user = contentText(request.messages.filter((m) => m.role === 'user').at(-1)?.content)
    for (const match of user.matchAll(/<(?:知识库片段|excerpts)>\n([\s\S]*?)\n<\/(?:知识库片段|excerpts)>/g)) {
      materials.push(match[1])
      if (!numberedParts(match[1]).length) observations.push(match[1])
    }
    for (const message of request.messages.filter((m) => m.role === 'tool')) {
      const text = contentText(message.content)
      materials.push(text)
      const parts = numberedParts(text)
      // 未编号的source_read及空结果保留供事实/诚实评分；它们不能变成[n]引用的支持证据。
      observations.push(parts.length ? parts.map((p) => p.header).join('\n') : text)
    }
  }
  const parts = materials.flatMap(numberedParts)
  return {
    provided: answer.citations.map((citation) => {
      const matches = parts.filter(
        (p) =>
          p.number === citation.n &&
          p.parentType === citation.parentType &&
          p.parentId === citation.parentId &&
          (p.parentType === 'note' || p.ownerId === citation.ownerId)
      )
      const versions = [...new Map(matches.map((p) => [p.header + '\n' + p.text, { header: p.header, text: p.text }])).values()]
      return {
        number: citation.n,
        title: citation.title,
        parentType: citation.parentType,
        parentId: citation.parentId,
        ownerId: citation.ownerId,
        header: versions.map((p) => p.header).join('\n'),
        text: versions.map((p) => p.text).join('\n\n'),
        versions,
        missing: !versions.length
      }
    }),
    reference,
    actualCitationCount: answer.citations.length,
    toolObservations: [...new Set(observations.filter(Boolean))],
    toolSteps: answer.steps
  }
}
