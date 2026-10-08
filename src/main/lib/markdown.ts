import { Lexer, type Token, type Tokens } from 'marked'
import type { DocNode } from '@shared/types'

// Markdown → 编辑器节点。AI 只需写 Markdown（模型最擅长、token 最省），结构由这里保证正确。
// 不支持的语法（表格、HTML 等）降级为普通段落，绝不产出非法节点。

type Mark = { type: string; attrs?: Record<string, unknown> }

function inline(tokens: Token[] | undefined, marks: Mark[] = []): DocNode[] {
  const out: DocNode[] = []
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...inline((t as Tokens.Strong).tokens, [...marks, { type: 'bold' }]))
        break
      case 'em':
        out.push(...inline((t as Tokens.Em).tokens, [...marks, { type: 'italic' }]))
        break
      case 'del':
        out.push(...inline((t as Tokens.Del).tokens, [...marks, { type: 'strike' }]))
        break
      case 'codespan':
        pushText(out, (t as Tokens.Codespan).text, [...marks, { type: 'code' }])
        break
      case 'link': {
        const l = t as Tokens.Link
        const safe = /^(https?:|mailto:|jiwei:)/i.test(l.href)
        out.push(...inline(l.tokens, safe ? [...marks, { type: 'link', attrs: { href: l.href } }] : marks))
        break
      }
      case 'br':
        out.push({ type: 'hardBreak' })
        break
      case 'text': {
        const tt = t as Tokens.Text
        if (tt.tokens?.length) out.push(...inline(tt.tokens, marks))
        else pushText(out, decode(tt.text), marks)
        break
      }
      case 'escape':
        pushText(out, (t as Tokens.Escape).text, marks)
        break
      default:
        if ('text' in t && typeof t.text === 'string') pushText(out, decode(t.text), marks)
    }
  }
  return out
}

function pushText(out: DocNode[], text: string, marks: Mark[]): void {
  if (!text) return
  out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text })
}

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

const para = (content: DocNode[]): DocNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' })

function blocks(tokens: Token[]): DocNode[] {
  const out: DocNode[] = []
  for (const t of tokens) {
    switch (t.type) {
      case 'paragraph':
        out.push(para(inline((t as Tokens.Paragraph).tokens)))
        break
      case 'text': {
        const tt = t as Tokens.Text
        out.push(para(tt.tokens ? inline(tt.tokens) : [{ type: 'text', text: decode(tt.text) }]))
        break
      }
      case 'heading': {
        const h = t as Tokens.Heading
        // 笔记中标题最多用到三级
        out.push({ type: 'heading', attrs: { level: Math.min(3, Math.max(1, h.depth)) }, content: inline(h.tokens) })
        break
      }
      case 'list': {
        const l = t as Tokens.List
        const items = l.items.map((it) => {
          const inner = blocks(it.tokens)
          return { type: 'listItem', content: inner.length ? inner : [para([])] }
        })
        out.push(
          l.ordered
            ? { type: 'orderedList', attrs: { start: typeof l.start === 'number' ? l.start : 1 }, content: items }
            : { type: 'bulletList', content: items }
        )
        break
      }
      case 'code': {
        const c = t as Tokens.Code
        out.push({
          type: 'codeBlock',
          attrs: { language: c.lang || null },
          ...(c.text ? { content: [{ type: 'text', text: c.text }] } : {})
        })
        break
      }
      case 'blockquote': {
        const inner = blocks((t as Tokens.Blockquote).tokens)
        out.push({ type: 'blockquote', content: inner.length ? inner : [para([])] })
        break
      }
      case 'hr':
        out.push({ type: 'horizontalRule' })
        break
      case 'table': {
        // 表格在 v0.3.3 支持；先降级为每行一个段落
        const tb = t as Tokens.Table
        const row = (cells: Tokens.TableCell[]): DocNode =>
          para(cells.flatMap((c, i) => [...(i ? [{ type: 'text', text: ' | ' }] : []), ...inline(c.tokens)]))
        out.push(row(tb.header), ...tb.rows.map(row))
        break
      }
      case 'space':
        break
      default:
        if ('text' in t && typeof t.text === 'string' && t.text.trim()) out.push(para([{ type: 'text', text: t.text.trim() }]))
    }
  }
  return out
}

/** Markdown 文本 → 块级节点数组（至少一个段落） */
export function markdownToNodes(md: string): (DocNode & { type: string })[] {
  const nodes = blocks(new Lexer({ gfm: true }).lex(md.replace(/\r\n/g, '\n')))
  return (nodes.length ? nodes : [para([])]) as (DocNode & { type: string })[]
}
