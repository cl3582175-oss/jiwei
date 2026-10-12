import { marked, type Token, type Tokens } from 'marked'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export function externalPluginUrl(value?: string): string | undefined {
  try {
    const url = new URL(value ?? '')
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}
/** 只将 Markdown token 映射为 React 文本/元素；不生成 HTML，图片完全不创建网络请求。 */
export function PluginReadme({ text }: { text: string }) {
  const { t } = useTranslation()
  const plain = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const render = (tokens: Token[]): ReactNode =>
    tokens.map((token, i) => {
      const children =
        'tokens' in token && token.tokens ? render(token.tokens as Token[]) : plain('text' in token ? String(token.text) : token.raw)
      switch (token.type) {
        case 'space':
          return null
        case 'heading':
          return (
            <h3 key={i} className="mt-3 font-semibold">
              {children}
            </h3>
          )
        case 'paragraph':
          return (
            <p key={i} className="my-2">
              {children}
            </p>
          )
        case 'strong':
          return <strong key={i}>{children}</strong>
        case 'em':
          return <em key={i}>{children}</em>
        case 'del':
          return <del key={i}>{children}</del>
        case 'br':
          return <br key={i} />
        case 'hr':
          return <hr key={i} className="border-border" />
        case 'code':
          return (
            <pre key={i} className="overflow-auto rounded bg-sunken p-3">
              <code>{plain(String(token.text))}</code>
            </pre>
          )
        case 'codespan':
          return <code key={i}>{plain(String(token.text))}</code>
        case 'blockquote':
          return (
            <blockquote key={i} className="border-l-2 border-border pl-3">
              {children}
            </blockquote>
          )
        case 'list':
          return (
            <ul key={i} className="list-inside list-disc">
              {(token.items as Tokens.ListItem[]).map((item, j) => (
                <li key={j}>{render(item.tokens)}</li>
              ))}
            </ul>
          )
        case 'link': {
          const href = externalPluginUrl(String(token.href))
          return href ? (
            <a key={i} href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline">
              {children}
            </a>
          ) : (
            <span key={i}>{children}</span>
          )
        }
        case 'image':
          return (
            <span key={i} className="text-muted">
              [{plain(String(token.text))} · {t('plugins.readmeImages')}]
            </span>
          )
        // HTML、表格或未识别 token 保留为文本，不给 Markdown 内容 DOM 权限。
        default:
          return <span key={i}>{children}</span>
      }
    })
  return (
    <div data-testid="plugin-readme" className="text-sm [overflow-wrap:anywhere]">
      {render(marked.lexer(text))}
    </div>
  )
}
