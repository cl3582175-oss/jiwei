import type { DocJSON } from '@shared/types'
import type { DocNode } from '@shared/types'
import { Marked, type Token, type Tokens } from 'marked'
import { parseDocument } from 'yaml'
import { parseHTML } from 'linkedom'
import { markdownToNodes } from './markdown'
export interface ImportReference {
  kind: 'note' | 'image' | 'attachment'
  target: string
  label: string
  anchor?: string
  wiki?: boolean
}
export interface ConvertedMarkdown {
  title: string
  tags: string[]
  aliases: string[]
  createdAt?: number
  ignored: string[]
  rows: number
  tasks: number
  refs: ImportReference[]
  doc: DocJSON
  embeds: Record<string, { kind: string; data: unknown }>
  issues: string[]
  issueCounts?: Record<string, number>
}
const lexer = new Marked({ gfm: true })
const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，]/) : [])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
const plainHTML = (html: string): string => {
  const { document } = parseHTML(`<html><body>${html}</body></html>`)
  for (const el of document.querySelectorAll('script,style,iframe,object')) el.remove()
  return document.body.textContent ?? ''
}

/** No network or storage side effects. Reference placeholders are resolved by the importer. */
export function importMarkdown(input: string, filename: string): ConvertedMarkdown {
  let body = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const result: ConvertedMarkdown = {
    title: filename.replace(/.*\//, '').replace(/\.[^.]+$/, ''),
    tags: [],
    aliases: [],
    ignored: [],
    rows: 0,
    tasks: 0,
    refs: [],
    doc: { type: 'doc', content: [] },
    embeds: {},
    issues: []
  }
  let frontTitle = false
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(body)
  if (fm) {
    body = body.slice(fm[0].length)
    try {
      const doc = parseDocument(fm[1], { uniqueKeys: true })
      if (doc.errors.length) throw new Error('Invalid YAML')
      const data: unknown = doc.toJS({ maxAliasCount: 50 })
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const props = data as Record<string, unknown>
        if (typeof props.title === 'string' && props.title.trim()) {
          result.title = props.title.trim()
          frontTitle = true
        }
        result.tags = [...strings(props.tags), ...strings(props.tag)]
        result.aliases = strings(props.aliases)
        const date = props.created ?? props.date
        const at = typeof date === 'string' ? Date.parse(date) : NaN
        if (Number.isFinite(at)) result.createdAt = at
        else if (date !== undefined) result.issues.push('invalid-date')
        result.ignored = Object.keys(props).filter((k) => !['title', 'tags', 'tag', 'created', 'date'].includes(k))
      }
    } catch {
      result.issues.push('invalid-frontmatter')
    }
  }
  const tokens = lexer.lexer(body)
  const resolvedLinks: { raw: string; markdown: string }[] = []
  lexer.walkTokens(tokens, (t) => {
    if ((t.type === 'link' || t.type === 'image') && !t.raw.includes('](')) {
      const l = t as Tokens.Link
      resolvedLinks.push({ raw: t.raw, markdown: `${t.type === 'image' ? '!' : ''}[${l.text}](${l.href.replace(/\)/g, '%29')})` })
    }
  })
  const h1 = tokens.findIndex((t) => t.type === 'heading' && (t as Tokens.Heading).depth === 1)
  if (!frontTitle && h1 >= 0) {
    result.title = (tokens[h1] as Tokens.Heading).text
    tokens.splice(h1, 1)
  }
  const originalTitle = result.title
  if (originalTitle.length > 500) result.issues.push('long-title')
  result.title = result.title.slice(0, 500).replace(/[\uD800-\uDBFF]$/, '') || filename

  // The Markdown parser decodes entities after prose strips HTML tags. Include
  // that normalized text when selecting markers, so normalization cannot turn
  // an ordinary source literal into one of our generated references.
  const normalizedText = plainHTML(input.replace(/<[^>]+>/g, (tag) => plainHTML(tag)))
  const usedPrefixes = new Set(`${input}\n${plainHTML(input)}\n${normalizedText}`.match(/JIWEIIMPORT\d+REF/g) ?? [])
  let salt = 0
  while (usedPrefixes.has(`JIWEIIMPORT${salt}REF`)) salt++
  const refPrefix = `JIWEIIMPORT${salt}REF`,
    refParts = new RegExp(`(${refPrefix}\\d+END)`),
    refMatch = new RegExp(`^${refPrefix}(\\d+)END$`)
  const reference = (kind: ImportReference['kind'], target: string, label: string, wiki: boolean): string => {
    const split = target.indexOf('#')
    const anchor = split >= 0 ? target.slice(split + 1) : undefined
    if (split >= 0) target = target.slice(0, split)
    const index = result.refs.push({ kind, target, label, ...(anchor ? { anchor } : {}), wiki }) - 1
    return `${refPrefix}${index}END`
  }
  // Process only prose, shielding literal inline code and LaTeX from tags/wiki syntax.
  const prose = (raw: string): string =>
    raw
      .split(/(`+[^`]*`+|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
      .map((part, i) => {
        if (i % 2) return part
        for (const link of resolvedLinks) part = part.replaceAll(link.raw, link.markdown)
        part = part.replace(
          /!?\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\(([^)\n]+)\)|\[([^\]\n]+)\]\(([^)\n]+)\)/g,
          (
            whole,
            wiki: string | undefined,
            alt: string | undefined,
            image: string | undefined,
            label: string | undefined,
            href: string | undefined
          ) => {
            if (wiki !== undefined) {
              const [target, alias] = wiki.split('|', 2)
              const embed = whole.startsWith('!')
              const kind = embed ? (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(target) ? 'image' : 'attachment') : 'note'
              return reference(kind, target, alias ?? target.replace(/#.*$/, ''), true)
            }
            const target = (image ?? href ?? '').replace(/^<|>$/g, '').split(/\s+["']/)[0]
            if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) {
              if (image !== undefined) {
                result.issues.push('remote-image')
                return alt || target
              }
              return whole
            }
            const kind =
              image !== undefined
                ? /\.(png|jpe?g|gif|webp|bmp|svg)(?:#.*)?$/i.test(target)
                  ? 'image'
                  : 'attachment'
                : /\.(md|markdown|txt|csv)(?:#.*)?$/i.test(target)
                  ? 'note'
                  : 'attachment'
            return reference(kind, target, alt ?? label ?? target, false)
          }
        )
        for (const m of part.matchAll(/(?:^|[^\p{L}\p{N}_/#])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) result.tags.push(m[1])
        part = part.replace(/^([ \t]*>\s*)\[!([\w-]+)\][ \t]*(.*)$/gm, '$1**$2 $3**')
        part = part.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s/gm, (_, prefix: string, checked: string) => {
          result.tasks++
          return `${prefix}${checked.trim() ? '☑' : '☐'} `
        })
        return part.replace(/<[^>]+>/g, (tag) => (/^<(https?:\/\/|mailto:)/i.test(tag) ? tag : plainHTML(tag)))
      })
      .join('')

  const replaceRefs = (node: DocNode): DocNode[] => {
    if (node.type === 'text') {
      return (node.text ?? '')
        .split(refParts)
        .filter(Boolean)
        .map((part) => {
          const m = refMatch.exec(part)
          if (!m) return { ...node, text: part }
          const idx = Number(m[1]),
            ref = result.refs[idx]
          if (!ref) return { ...node, text: part }
          if (ref.kind === 'image') return { type: 'image', attrs: { importRef: idx, alt: ref.label } }
          return {
            type: 'text',
            text: ref.label,
            marks: [...(node.marks ?? []), { type: 'link', attrs: { href: `jiwei://import/${idx}` } }]
          }
        })
    }
    const content = node.content?.flatMap(replaceRefs)
    if ((node.type === 'paragraph' || node.type === 'heading') && content?.some((n) => n.type === 'image')) {
      const out: DocNode[] = [],
        segment: DocNode[] = []
      for (const n of content) {
        if (n.type === 'image') {
          if (segment.length) out.push({ ...node, content: segment.splice(0) })
          out.push(n)
        } else segment.push(n)
      }
      if (segment.length) out.push({ ...node, content: segment })
      return out
    }
    return [{ ...node, ...(content ? { content } : {}) }]
  }
  const convert = (ts: Token[]): DocNode[] =>
    ts.flatMap((token) => {
      if (token.type === 'space') return []
      if (token.type === 'code' && (token as Tokens.Code).lang === 'mermaid') {
        const code = (token as Tokens.Code).text,
          id = `import-diagram-${Object.keys(result.embeds).length}`
        if (code.length < 5 || code.length > 12000) {
          result.issues.push('invalid-mermaid-size')
          return markdownToNodes(token.raw)
        }
        result.embeds[id] = { kind: 'diagram', data: { code } }
        return [{ type: 'embed', attrs: { id, kind: 'diagram' } }]
      }
      if (token.type === 'code') return markdownToNodes(token.raw)
      if (token.type === 'html') return [{ type: 'paragraph', content: [{ type: 'text', text: plainHTML(token.raw) }] }]
      return markdownToNodes(prose(token.raw)).flatMap(replaceRefs)
    })
  const sections: { cue: string; tokens: Token[] }[] = []
  let section = { cue: '', tokens: [] as Token[] }
  for (const t of tokens) {
    if (t.type === 'heading' && (t as Tokens.Heading).depth === 2) {
      if (section.cue || section.tokens.some((x) => x.type !== 'space')) sections.push(section)
      section = { cue: (t as Tokens.Heading).text, tokens: [] }
    } else section.tokens.push(t)
  }
  if (section.cue || section.tokens.length || !sections.length) sections.push(section)
  const rows: { cue: string; nodes: DocNode[] }[] = []
  for (const s of sections) {
    const nodes = convert(s.tokens)
    if (sections.length === 1 && !s.cue && body.length > 3000) {
      let group: DocNode[] = [],
        size = 0
      const split = (node: DocNode): DocNode[] => {
        if (node.type !== 'paragraph' || !node.content?.every((n) => n.type === 'text') || JSON.stringify(node).length <= 3000)
          return [node]
        const out: DocNode[] = [],
          children: DocNode[] = []
        let chars = 0
        for (const child of node.content) {
          let value = Array.from(child.text ?? '')
          while (value.length) {
            const part = value.slice(0, 2800 - chars)
            value = value.slice(part.length)
            children.push({ ...child, text: part.join('') })
            chars += part.length
            if (chars === 2800) {
              out.push({ ...node, content: children.splice(0) })
              chars = 0
            }
          }
        }
        if (children.length) out.push({ ...node, content: children })
        return out
      }
      for (const node of nodes.flatMap(split)) {
        const n = JSON.stringify(node).length
        if (size > 3000 && group.length) {
          rows.push({ cue: '', nodes: group })
          group = []
          size = 0
        }
        group.push(node)
        size += n
      }
      rows.push({ cue: '', nodes: group })
    } else rows.push({ cue: s.cue, nodes })
  }
  const allTags = [...new Set(result.tags)]
  result.tags = allTags.filter((t) => t.length <= 100).slice(0, 100)
  const selectedTags = new Set(result.tags)
  const overflowTags = allTags.filter((t) => !selectedTags.has(t))
  if (overflowTags.length) {
    result.issues.push('tag-limit')
    result.issueCounts = { 'tag-limit': overflowTags.length }
  }
  result.rows = rows.length
  const paragraph = (value: string): DocNode => ({ type: 'paragraph', ...(value ? { content: [{ type: 'text', text: value }] } : {}) })
  if (originalTitle.length > 500) rows[0].nodes.unshift(paragraph(originalTitle))
  if (overflowTags.length) rows[0].nodes.unshift(paragraph(overflowTags.map((tag) => `#${tag}`).join(' ')))
  result.doc.content = [
    ...rows.map((r) => ({
      type: 'cornellRow',
      content: [
        { type: 'cornellCue', content: [paragraph(r.cue)] },
        { type: 'cornellBody', content: r.nodes.length ? r.nodes : [paragraph('')] }
      ]
    })),
    { type: 'cornellSummary', content: [paragraph('')] }
  ]
  return result
}

export function decodeImportText(bytes: Uint8Array): { text: string; encoding: 'UTF-8' | 'GBK' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'GBK' }
  }
}
