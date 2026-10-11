// MCP 的纯函数部分（便于单元测试）：工具结果转文本、给模型看的工具名。

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType?: string }
  | { type: 'audio'; mimeType?: string }
  | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: string; [k: string]: unknown }

export interface ToolResultLike {
  content?: Content[]
  structuredContent?: unknown
  isError?: boolean
  toolResult?: unknown
}

const MAX = 20_000

/** 工具结果 → 文本：文字原样，图片 / 音频给出说明，资源取其文字 */
export function resultText(r: ToolResultLike, zh: boolean): string {
  const parts: string[] = []
  for (const c of r.content ?? []) {
    if (c.type === 'text') parts.push(String((c as { text: string }).text))
    else if (c.type === 'image') parts.push(zh ? `[图片 ${String(c.mimeType ?? '')}]` : `[image ${String(c.mimeType ?? '')}]`)
    else if (c.type === 'audio') parts.push(zh ? '[音频]' : '[audio]')
    else if (c.type === 'resource') {
      const res = (c as { resource: { uri: string; text?: string } }).resource
      parts.push(res.text ?? (zh ? `[资源 ${res.uri}]` : `[resource ${res.uri}]`))
    } else if (c.type === 'resource_link') parts.push(`[${String(c.name ?? c.uri)}](${String(c.uri)})`)
  }
  if (!parts.join('').trim()) {
    const structured = r.structuredContent ?? r.toolResult
    if (structured !== undefined) parts.push(JSON.stringify(structured))
  }
  const text = parts.join('\n').trim() || (zh ? '（没有返回内容）' : '(no content)')
  return text.length > MAX ? `${text.slice(0, MAX)}\n…` : text
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/**
 * 给模型看的工具名：mcp__<服务器>__<工具>，只含字母数字下划线连字符，最长 64（各家函数名的共同限制）。
 * 服务器名是中文等非 ASCII 时用 ID 前缀代替。
 */
export function exposedName(serverName: string, serverId: string, tool: string): string {
  const server = (slug(serverName) || `s${serverId.replace(/[^a-z0-9]/gi, '').slice(0, 6)}`).slice(0, 20)
  const t = tool.replace(/[^a-zA-Z0-9_-]+/g, '_')
  const name = `mcp__${server}__${t}`
  if (name.length <= 64) return name
  let h = 0
  for (const ch of tool) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `${name.slice(0, 56)}_${h.toString(36).slice(0, 7)}`
}
