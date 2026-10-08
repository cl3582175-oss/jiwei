import { createHash } from 'crypto'

// 交互演示的沙箱页面：jiwei://sandbox/<哈希>。
// 独立的源 + 自己的 CSP（允许内联脚本，禁止一切网络），配合 iframe 的 sandbox（无 allow-same-origin）完全隔离。
// （srcdoc / blob 页面会继承应用自身的 CSP，内联脚本无法运行，因此单独提供。）

const MAX = 64
const pages = new Map<string, string>()

export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'"

export function registerSandbox(html: string): string {
  const id = createHash('sha256').update(html).digest('hex').slice(0, 32)
  pages.delete(id)
  pages.set(id, html)
  // 只保留最近的若干个页面
  while (pages.size > MAX) pages.delete(pages.keys().next().value!)
  return `jiwei://sandbox/${id}`
}

export function sandboxResponse(id: string): Response {
  const html = pages.get(id)
  if (!html) return new Response('Not found', { status: 404 })
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': SANDBOX_CSP,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}
