import { Marked, type Token, type Tokens } from 'marked'
import type { DocNode } from '@shared/types'

// Markdown → 编辑器节点。AI 只需写 Markdown（模型最擅长、token 最省），结构由这里保证正确。
// 不支持的语法（表格、HTML 等）降级为普通段落，绝不产出非法节点。

type Mark = { type: string; attrs?: Record<string, unknown> }

function inline(tokens: Token[] | undefined, marks: Mark[] = []): DocNode[] {
  const out: DocNode[] = []
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'inlineMath':
        out.push({ type: 'inlineMath', attrs: { latex: (t as Token & { latex: string }).latex } })
        break
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
      case 'blockMath':
        out.push({ type: 'blockMath', attrs: { latex: (t as Token & { latex: string }).latex } })
        break
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
        const tb = t as Tokens.Table
        const cells = (cs: Tokens.TableCell[], type: string): DocNode[] => cs.map((c) => ({ type, content: [para(inline(c.tokens))] }))
        const width = tb.header.length
        // 补齐缺失的单元格，保证每行列数一致
        const blank = { text: '', tokens: [], header: false, align: null } as Tokens.TableCell
        const pad = (cs: Tokens.TableCell[]): Tokens.TableCell[] =>
          cs.length >= width ? cs.slice(0, width) : [...cs, ...Array.from({ length: width - cs.length }, () => blank)]
        out.push({
          type: 'table',
          content: [
            { type: 'tableRow', content: cells(tb.header, 'tableHeader') },
            ...tb.rows.map((r) => ({ type: 'tableRow', content: cells(pad(r), 'tableCell') }))
          ]
        })
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

// 先于 Markdown 转义/强调分词，避免 LaTeX 的反斜杠与下标被吞掉；代码与转义仍由 marked 优先处理。
const mathMarkdown = new Marked({
  gfm: true,
  extensions: [
    {
      name: 'blockMath',
      level: 'block',
      start: (src) => src.indexOf('$$'),
      tokenizer(src) {
        const m = /^\$\$([^]*?)\$\$(?:[ \t]*\n|[ \t]*$)/.exec(src)
        if (m?.[1].trim()) return { type: 'blockMath', raw: m[0], latex: m[1].trim() }
      }
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start: (src) => src.indexOf('$'),
      tokenizer(src) {
        const m = /^\$(?!\$)((?:\\.|[^$\n])+?)\$(?!\$)/.exec(src)
        if (m?.[1].trim()) return { type: 'inlineMath', raw: m[0], latex: m[1].trim() }
      }
    }
  ]
})

/** Markdown 文本 → 块级节点数组（至少一个段落） */
export function markdownToNodes(md: string): (DocNode & { type: string })[] {
  const nodes = blocks(mathMarkdown.lexer(md.replace(/\r\n/g, '\n')))
  return (nodes.length ? nodes : [para([])]) as (DocNode & { type: string })[]
}

/* ——— 编辑器节点 → Markdown（给模型看原文，修改时保留格式） ——— */

function inlineMd(nodes: DocNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'inlineMath') return `$${String(n.attrs?.latex ?? '')}$`
      if (n.type === 'hardBreak') return '  \n'
      if (n.type !== 'text') return ''
      let t = n.text ?? ''
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`
        else if (m.type === 'italic') t = `*${t}*`
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'code') t = `\`${t}\``
        else if (m.type === 'link' && typeof m.attrs?.href === 'string') t = `[${t}](${m.attrs.href})`
      }
      return t
    })
    .join('')
}

export function nodesToMarkdown(nodes: DocNode[], indent = ''): string {
  const out: string[] = []
  for (const n of nodes) {
    switch (n.type) {
      case 'blockMath':
        out.push(`$$\n${String(n.attrs?.latex ?? '')}\n$$`)
        break
      case 'paragraph':
        out.push(indent + inlineMd(n.content))
        break
      case 'heading':
        out.push(`${'#'.repeat(Number(n.attrs?.level ?? 2))} ${inlineMd(n.content)}`)
        break
      case 'bulletList':
      case 'orderedList':
        out.push(
          (n.content ?? [])
            .map((li, i) => {
              const mark = n.type === 'orderedList' ? `${Number(n.attrs?.start ?? 1) + i}.` : '-'
              const [first, ...rest] = li.content ?? []
              const head = `${indent}${mark} ${first ? nodesToMarkdown([first]).trim() : ''}`
              return rest.length ? `${head}\n${nodesToMarkdown(rest, indent + '  ').replace(/\n\n/g, '\n')}` : head
            })
            .join('\n')
        )
        break
      case 'blockquote':
        out.push(
          nodesToMarkdown(n.content ?? [])
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n')
        )
        break
      case 'codeBlock':
        out.push('```' + String(n.attrs?.language ?? '') + '\n' + (n.content ?? []).map((c) => c.text ?? '').join('') + '\n```')
        break
      case 'horizontalRule':
        out.push('---')
        break
      case 'table': {
        const rows = (n.content ?? []).map((r) =>
          (r.content ?? []).map((c) =>
            nodesToMarkdown(c.content ?? [])
              .replace(/\n+/g, ' ')
              .replace(/\|/g, '\\|')
          )
        )
        if (!rows.length) break
        const w = Math.max(...rows.map((r) => r.length))
        const line = (r: string[]): string => `| ${[...r, ...Array<string>(w - r.length).fill('')].join(' | ')} |`
        out.push([line(rows[0]), `| ${Array<string>(w).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'))
        break
      }
      default:
        if (n.content) out.push(nodesToMarkdown(n.content, indent))
    }
  }
  // 块之间空一行，避免相邻段落被合并
  return out.join('\n\n')
}
