import { createHash } from 'crypto'
import type { DocJSON, DocNode } from '@shared/types'
import { embedText } from '@shared/embeds'

// 从康奈尔文档 JSON 派生检索与 RAG 所需的结构化数据。纯函数，无 Electron 依赖，便于单元测试。
//
// 文档结构：
//   doc
//   ├── cornellRow* (id)       一行 = 一个知识点：左线索 + 右笔记
//   │   ├── cornellCue  → 段落级节点*
//   │   └── cornellBody → 段落级节点*
//   └── cornellSummary (id)  → 段落级节点*

export const NODE = {
  row: 'cornellRow',
  cue: 'cornellCue',
  body: 'cornellBody',
  summary: 'cornellSummary'
} as const

export type BlockOrigin = 'user' | 'ai' | 'ai_reviewed'

/** 解析节点的来源属性（JSON 字符串） */
export function parseOrigin(attr: unknown): BlockOrigin {
  if (typeof attr !== 'string' || !attr) return 'user'
  try {
    const o = JSON.parse(attr) as { by?: string; reviewed?: boolean }
    return o.by === 'ai' ? (o.reviewed ? 'ai_reviewed' : 'ai') : 'user'
  } catch {
    return 'user'
  }
}

export type EmbedsData = Record<string, { kind?: string; data?: unknown }>

export interface DerivedBlock {
  id: string
  kind: string
  origin: BlockOrigin
  section: 'row' | 'cue' | 'body' | 'summary'
  rowId: string | null
  position: number
  text: string
  hash: string
}

export interface DerivedLink {
  toType: 'note' | 'source'
  toId: string
  fromBlockId: string | null
}

export interface Derived {
  blocks: DerivedBlock[]
  plainText: string
  /** AI 生成且未经审阅的文字（不计入学习统计） */
  aiText: string
  assetIds: string[]
  links: DerivedLink[]
}

const ASSET_RE = /^jiwei:\/\/asset\/([0-9a-f]{64})(?:\.[a-z0-9]+)?$/i
const LINK_RE = /^jiwei:\/\/(note|source)\/([0-9a-f-]{36})/i

export function hashText(kind: string, text: string): string {
  return createHash('sha1').update(kind).update('\0').update(text).digest('hex')
}

/** 节点纯文本；块级子节点之间以换行分隔 */
export function nodeText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (!node.content) return ''
  const inline = node.content.every((c) => c.type === 'text' || c.type === 'hardBreak' || c.type === 'image')
  return node.content.map(nodeText).join(inline ? '' : '\n')
}

function walk(node: DocNode, visit: (n: DocNode) => void): void {
  visit(node)
  node.content?.forEach((c) => walk(c, visit))
}

export function deriveDoc(doc: DocJSON, embeds: EmbedsData = {}): Derived {
  const blocks: DerivedBlock[] = []
  const aiTexts: string[] = []
  /** 节点文本：富内容块取其数据的文字表示 */
  const textOf = (n: DocNode): string => {
    if (n.type === 'embed') {
      const id = typeof n.attrs?.id === 'string' ? n.attrs.id : ''
      const e = embeds[id]
      return e?.kind ? embedText(e.kind, e.data) : ''
    }
    return nodeText(n)
  }
  const assetIds = new Set<string>()
  const links: DerivedLink[] = []
  const texts: string[] = []
  let position = 0

  const pushChildren = (container: DocNode | undefined, section: 'cue' | 'body' | 'summary', rowId: string | null): string => {
    const parts: string[] = []
    for (const child of container?.content ?? []) {
      const text = textOf(child).trim()
      parts.push(text)
      const id = child.attrs?.id
      const origin = parseOrigin(child.attrs?.origin)
      if (origin === 'ai' && text) aiTexts.push(text)
      if (typeof id === 'string' && id && text) {
        blocks.push({
          id,
          kind: child.type ?? 'unknown',
          origin,
          section,
          rowId,
          position: position++,
          text,
          hash: hashText(child.type ?? '', text)
        })
      }
      walk(child, (n) => {
        if (n.type === 'image' && typeof n.attrs?.src === 'string') {
          const m = ASSET_RE.exec(n.attrs.src)
          if (m) assetIds.add(m[1].toLowerCase())
        }
        for (const mark of n.marks ?? []) {
          if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
            const m = LINK_RE.exec(mark.attrs.href)
            if (m) links.push({ toType: m[1] as 'note' | 'source', toId: m[2], fromBlockId: typeof id === 'string' ? id : null })
          }
        }
      })
    }
    return parts.filter(Boolean).join('\n')
  }

  for (const top of doc.content ?? []) {
    if (top.type === NODE.row) {
      const rowId = typeof top.attrs?.id === 'string' ? top.attrs.id : null
      const rowPos = position++
      const cue = top.content?.find((c) => c.type === NODE.cue)
      const body = top.content?.find((c) => c.type === NODE.body)
      const cueText = pushChildren(cue, 'cue', rowId)
      const bodyText = pushChildren(body, 'body', rowId)
      const rowText = [cueText, bodyText].filter(Boolean).join('\n')
      if (rowText) texts.push(rowText)
      // 行块：线索 + 笔记，作为 RAG 的天然检索单元
      if (rowId && rowText) {
        blocks.push({
          id: rowId,
          kind: NODE.row,
          origin: parseOrigin(top.attrs?.origin),
          section: 'row',
          rowId: null,
          position: rowPos,
          text: rowText,
          hash: hashText(NODE.row, rowText)
        })
      }
    } else if (top.type === NODE.summary) {
      const text = pushChildren(top, 'summary', null)
      if (text) texts.push(text)
    }
  }

  return {
    blocks: blocks.sort((a, b) => a.position - b.position),
    plainText: texts.join('\n'),
    aiText: aiTexts.join('\n'),
    assetIds: [...assetIds],
    links
  }
}

/** 中英文混合字数：每个 CJK 字符计 1，每个拉丁单词计 1 */
export function countWords(text: string): number {
  const cjk = text.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0
  const latin = text.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0
  return cjk + latin
}

export interface ExistingBlock {
  id: string
  hash: string
  deletedAt: number | null
}

export interface BlockDiff {
  inserted: DerivedBlock[]
  changed: DerivedBlock[]
  /** 位置变化但内容未变 */
  moved: DerivedBlock[]
  revived: DerivedBlock[]
  removedIds: string[]
}

/** 对比新旧块：决定哪些块需要刷新“修改时间” —— 段落级时间戳的核心 */
export function diffBlocks(prev: ExistingBlock[], next: DerivedBlock[]): BlockDiff {
  const old = new Map(prev.map((b) => [b.id, b]))
  const out: BlockDiff = { inserted: [], changed: [], moved: [], revived: [], removedIds: [] }
  const seen = new Set<string>()
  for (const b of next) {
    seen.add(b.id)
    const o = old.get(b.id)
    if (!o) out.inserted.push(b)
    else if (o.deletedAt !== null) out.revived.push(b)
    else if (o.hash !== b.hash) out.changed.push(b)
    else out.moved.push(b)
  }
  for (const o of prev) if (!seen.has(o.id) && o.deletedAt === null) out.removedIds.push(o.id)
  return out
}
