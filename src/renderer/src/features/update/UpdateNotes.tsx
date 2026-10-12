import { marked, type Token, type Tokens } from 'marked'
import type { ReactNode } from 'react'
import { api } from '@/lib/utils'

export function UpdateNotes({ text }: { text: string }) {
  const render = (tokens: Token[]): ReactNode =>
    tokens.map((token, i) => {
      const content = 'tokens' in token && token.tokens ? render(token.tokens as Token[]) : 'text' in token ? String(token.text) : token.raw
      switch (token.type) {
        case 'space':
          return null
        case 'heading':
          return (
            <h4 key={i} className="mt-3 font-semibold">
              {content}
            </h4>
          )
        case 'paragraph':
          return (
            <p key={i} className="my-2">
              {content}
            </p>
          )
        case 'strong':
          return <strong key={i}>{content}</strong>
        case 'em':
          return <em key={i}>{content}</em>
        case 'codespan':
          return <code key={i}>{content}</code>
        case 'code':
          return (
            <pre key={i} className="overflow-auto rounded bg-sunken p-2">
              <code>{String(token.text)}</code>
            </pre>
          )
        case 'list':
          return (
            <ul key={i} className="list-inside list-disc">
              {(token.items as Tokens.ListItem[]).map((item, j) => (
                <li key={j}>{render(item.tokens)}</li>
              ))}
            </ul>
          )
        case 'blockquote':
          return (
            <blockquote key={i} className="border-l-2 border-border pl-3">
              {content}
            </blockquote>
          )
        case 'link': {
          let safe = false
          try {
            const url = new URL(String(token.href))
            safe = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
          } catch {
            /* Unsafe links stay text. */
          }
          return safe ? (
            <button
              key={i}
              className="text-accent underline"
              onClick={() => void api.updates.openLink(String(token.href)).catch(() => undefined)}
            >
              {content}
            </button>
          ) : (
            <span key={i}>{content}</span>
          )
        }
        case 'image':
          return <span key={i}>[{String(token.text)}]</span>
        case 'br':
          return <br key={i} />
        case 'hr':
          return <hr key={i} className="border-border" />
        default:
          return <span key={i}>{content}</span>
      }
    })
  return (
    <div data-testid="update-notes" className="text-sm [overflow-wrap:anywhere]">
      {render(marked.lexer(text))}
    </div>
  )
}
