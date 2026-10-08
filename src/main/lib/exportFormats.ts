import type { DocJSON, DocNode } from '@shared/types'
import { MindmapDataSchema, toTree, type MindmapTree } from '@shared/embeds/mindmap'
import { ChartDataSchema, DiagramDataSchema, InteractiveDataSchema, StepsDataSchema, TimelineDataSchema } from '@shared/embeds/visuals'
import { nodesToMarkdown } from './markdown'
import { nodeText } from './derive'

// 笔记导出：康奈尔文档 → Markdown / HTML（纯函数，便于测试；文件、PDF、Word 由 services/exportNote 处理）。
// 富内容块：有截图（渲染进程提供的 SVG / PNG）时用图片，否则用文字形式（导图→列表、图示→Mermaid 代码……）。

export type EmbedsData = Record<string, { kind?: string; data?: unknown }>
export interface EmbedImage {
  svg?: string
  /** PNG data URL 与像素尺寸（Word 需要位图） */
  png?: string
  width?: number
  height?: number
}
export interface ExportMeta {
  title: string
  learnedAt: number
  lang: string
}

export interface CornellParts {
  rows: { cue: DocNode[]; body: DocNode[] }[]
  summary: DocNode[]
}

export function cornellParts(doc: DocJSON): CornellParts {
  const rows: CornellParts['rows'] = []
  let summary: DocNode[] = []
  for (const top of doc.content ?? []) {
    if (top.type === 'cornellRow') {
      const cue = top.content?.find((c) => c.type === 'cornellCue')?.content ?? []
      const body = top.content?.find((c) => c.type === 'cornellBody')?.content ?? []
      if (!nodeText({ content: [...cue, ...body] }).trim() && ![...cue, ...body].some((n) => n.type === 'embed' || n.type === 'image'))
        continue
      rows.push({ cue, body })
    } else if (top.type === 'cornellSummary') summary = top.content ?? []
  }
  return { rows, summary }
}

const fmtDate = (ts: number, lang: string): string =>
  new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ts))

/* ——— 富内容块的文字形式 ——— */

function mindmapList(tree: MindmapTree): string {
  const lines: string[] = []
  const walk = (t: MindmapTree, d: number): void => {
    lines.push(`${'  '.repeat(d)}- ${t.text}`)
    t.children.forEach((c) => walk(c, d + 1))
  }
  walk(tree, 0)
  return lines.join('\n')
}

/** 富内容块 → Markdown 文本（不依赖图片） */
export function embedMarkdown(kind: string, data: unknown, zh: boolean): string {
  switch (kind) {
    case 'mindmap': {
      const r = MindmapDataSchema.safeParse(data)
      const tree = r.success ? toTree(r.data) : null
      return tree ? mindmapList(tree) : ''
    }
    case 'diagram': {
      const r = DiagramDataSchema.safeParse(data)
      return r.success ? `${r.data.title ? `**${r.data.title}**\n\n` : ''}\`\`\`mermaid\n${r.data.code}\n\`\`\`` : ''
    }
    case 'chart': {
      const r = ChartDataSchema.safeParse(data)
      if (!r.success) return ''
      const d = r.data
      const head = d.title ? `**${d.title}**\n\n` : ''
      if (d.type === 'scatter')
        return head + d.series.map((s) => `- ${s.name}：${s.data.map((v) => `(${(v as number[]).join(', ')})`).join(' ')}`).join('\n')
      const rows = (d.categories ?? []).map((c, i) => `| ${c} | ${d.series.map((s) => String(s.data[i])).join(' | ')} |`)
      return `${head}| ${d.xLabel ?? ''} | ${d.series.map((s) => s.name).join(' | ')} |\n| --- | ${d.series.map(() => '---').join(' | ')} |\n${rows.join('\n')}${d.note ? `\n\n${d.note}` : ''}`
    }
    case 'timeline': {
      const r = TimelineDataSchema.safeParse(data)
      if (!r.success) return ''
      return `${r.data.title ? `**${r.data.title}**\n\n` : ''}${r.data.events.map((e) => `- **${e.date}** ${e.title}${e.detail ? `：${e.detail}` : ''}`).join('\n')}`
    }
    case 'steps': {
      const r = StepsDataSchema.safeParse(data)
      if (!r.success) return ''
      const d = r.data
      return `${d.title ? `**${d.title}**\n\n` : ''}\`\`\`${d.language}\n${d.code}\n\`\`\`\n\n${d.steps.map((s, i) => `${i + 1}. （${zh ? '第' : 'L'} ${s.lines.join(', ')} ${zh ? '行' : ''}）${s.note}`).join('\n')}`
    }
    case 'interactive': {
      const r = InteractiveDataSchema.safeParse(data)
      return r.success
        ? `> ${zh ? '交互演示' : 'Interactive demo'}：${r.data.title}${r.data.description ? ` —— ${r.data.description}` : ''}${zh ? '（请在积微中打开）' : ' (open in Jiwei)'}`
        : ''
    }
    default:
      return ''
  }
}

/* ——— Markdown ——— */

export function toMarkdown(
  doc: DocJSON,
  embeds: EmbedsData,
  meta: ExportMeta,
  opts: { image: (id: string) => string | null; asset: (src: string) => string }
): string {
  const zh = meta.lang.startsWith('zh')
  const { rows, summary } = cornellParts(doc)
  const body = (nodes: DocNode[]): string =>
    nodes
      .map((n) => {
        if (n.type === 'embed') {
          const id = String(n.attrs?.id ?? '')
          const e = embeds[id]
          if (!e?.kind) return ''
          const img = opts.image(id)
          // 图示保留 Mermaid 源码（多数 Markdown 编辑器可直接渲染），其余有截图时用图片
          if (img && e.kind !== 'diagram') return `![${e.kind}](${img})`
          return embedMarkdown(e.kind, e.data, zh)
        }
        if (n.type === 'image') return `![${String(n.attrs?.alt ?? '')}](${opts.asset(String(n.attrs?.src ?? ''))})`
        return nodesToMarkdown([n])
      })
      .filter(Boolean)
      .join('\n\n')
  const out = [`# ${meta.title || (zh ? '无标题' : 'Untitled')}`, `> ${zh ? '学习于' : 'Learned'} ${fmtDate(meta.learnedAt, meta.lang)}`]
  for (const r of rows) {
    const cue = nodeText({ content: r.cue }).trim()
    if (cue) out.push(`## ${cue.replace(/\n+/g, ' ')}`)
    const b = body(r.body)
    if (b) out.push(b)
  }
  const s = body(summary)
  if (s) out.push(`## ${zh ? '总结' : 'Summary'}`, s)
  return out.join('\n\n') + '\n'
}

/* ——— HTML（自包含，康奈尔两栏版式） ——— */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inlineHtml(nodes: DocNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'hardBreak') return '<br>'
      if (n.type !== 'text') return ''
      let t = esc(n.text ?? '')
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `<strong>${t}</strong>`
        else if (m.type === 'italic') t = `<em>${t}</em>`
        else if (m.type === 'strike') t = `<s>${t}</s>`
        else if (m.type === 'code') t = `<code>${t}</code>`
        else if (m.type === 'link' && typeof m.attrs?.href === 'string' && /^https?:/i.test(m.attrs.href))
          t = `<a href="${esc(m.attrs.href)}">${t}</a>`
      }
      return t
    })
    .join('')
}

export function blocksHtml(nodes: DocNode[], embed: (n: DocNode) => string, asset: (src: string) => string): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'paragraph':
          return `<p>${inlineHtml(n.content) || '&nbsp;'}</p>`
        case 'heading': {
          const l = Math.min(4, Number(n.attrs?.level ?? 2) + 1)
          return `<h${l}>${inlineHtml(n.content)}</h${l}>`
        }
        case 'bulletList':
        case 'orderedList': {
          const tag = n.type === 'bulletList' ? 'ul' : 'ol'
          return `<${tag}>${(n.content ?? []).map((li) => `<li>${blocksHtml(li.content ?? [], embed, asset)}</li>`).join('')}</${tag}>`
        }
        case 'blockquote':
          return `<blockquote>${blocksHtml(n.content ?? [], embed, asset)}</blockquote>`
        case 'codeBlock':
          return `<pre><code>${esc((n.content ?? []).map((c) => c.text ?? '').join(''))}</code></pre>`
        case 'horizontalRule':
          return '<hr>'
        case 'table':
          return `<table>${(n.content ?? [])
            .map(
              (r) =>
                `<tr>${(r.content ?? []).map((c) => (c.type === 'tableHeader' ? `<th>${blocksHtml(c.content ?? [], embed, asset)}</th>` : `<td>${blocksHtml(c.content ?? [], embed, asset)}</td>`)).join('')}</tr>`
            )
            .join('')}</table>`
        case 'image':
          return `<img src="${esc(asset(String(n.attrs?.src ?? '')))}" alt="${esc(String(n.attrs?.alt ?? ''))}">`
        case 'embed':
          return embed(n)
        default:
          return n.content ? blocksHtml(n.content, embed, asset) : ''
      }
    })
    .join('\n')
}

export const EXPORT_CSS = `
:root{--accent:#2f6f62;--fg:#1f2421;--muted:#5d6661;--border:#dfe3df;--sunken:#f3f5f2}
*{box-sizing:border-box}
body{margin:0;padding:40px 48px;font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:var(--fg);background:#fff}
h1{font-family:"Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif;font-size:28px;margin:0 0 4px}
.meta{color:var(--muted);font-size:13px;margin-bottom:24px}
.cornell{border:1px solid var(--border);border-radius:10px;overflow:hidden}
.row{display:grid;grid-template-columns:30% 70%;border-bottom:1px dashed var(--border);break-inside:avoid}
.cue{padding:14px 16px;border-right:1px solid var(--border);color:var(--accent);font-family:"Kaiti SC","STKaiti","KaiTi",serif;font-size:15px}
.body{padding:14px 18px;min-width:0}
.summary{padding:14px 18px;background:var(--sunken)}
.summary-label{font-size:12px;color:var(--muted);letter-spacing:.1em}
p{margin:.35em 0}ul,ol{padding-left:1.4em;margin:.35em 0}
blockquote{margin:.5em 0;padding-left:12px;border-left:3px solid var(--border);color:var(--muted)}
pre{background:var(--sunken);border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:12.5px}
code{font-family:"SF Mono",Menlo,Consolas,monospace}
table{border-collapse:collapse;width:100%;margin:.5em 0;font-size:14px}
th,td{border:1px solid var(--border);padding:5px 9px;text-align:left;vertical-align:top}th{background:var(--sunken)}
img,svg{max-width:100%;height:auto}.embed svg{position:static!important;display:inline-block}
.embed{margin:.6em 0;padding:8px;border:1px solid var(--border);border-radius:8px;text-align:center}
.embed .cap{font-size:12px;color:var(--muted);margin-top:4px}
.timeline{list-style:none;padding:0;text-align:left}.timeline li{margin:.3em 0}.timeline b{color:var(--accent);margin-right:8px}
a{color:var(--accent)}
@media print{body{padding:0}.row{break-inside:avoid}}
`

export function toHtml(
  doc: DocJSON,
  embeds: EmbedsData,
  meta: ExportMeta,
  images: Record<string, EmbedImage>,
  asset: (src: string) => string
): string {
  const zh = meta.lang.startsWith('zh')
  const { rows, summary } = cornellParts(doc)
  const embed = (n: DocNode): string => {
    const id = String(n.attrs?.id ?? '')
    const e = embeds[id]
    if (!e?.kind) return ''
    const img = images[id]
    if (img?.svg) return `<div class="embed">${img.svg}</div>`
    if (img?.png) return `<div class="embed"><img src="${img.png}" alt="${esc(e.kind)}"></div>`
    if (e.kind === 'timeline') {
      const r = TimelineDataSchema.safeParse(e.data)
      if (r.success)
        return `<div class="embed"><ul class="timeline">${r.data.events.map((x) => `<li><b>${esc(x.date)}</b>${esc(x.title)}${x.detail ? ` — ${esc(x.detail)}` : ''}</li>`).join('')}</ul></div>`
    }
    if (e.kind === 'steps') {
      const r = StepsDataSchema.safeParse(e.data)
      if (r.success)
        return `<div class="embed" style="text-align:left"><pre><code>${esc(r.data.code)}</code></pre><ol>${r.data.steps.map((s) => `<li>${esc(s.note)}</li>`).join('')}</ol></div>`
    }
    return `<div class="embed" style="text-align:left"><pre>${esc(embedMarkdown(e.kind, e.data, zh))}</pre></div>`
  }
  const rowsHtml = rows
    .map(
      (r) =>
        `<div class="row"><div class="cue">${blocksHtml(r.cue, embed, asset)}</div><div class="body">${blocksHtml(r.body, embed, asset)}</div></div>`
    )
    .join('\n')
  const sum = nodeText({ content: summary }).trim()
    ? `<div class="summary"><div class="summary-label">${zh ? '总结' : 'SUMMARY'}</div>${blocksHtml(summary, embed, asset)}</div>`
    : ''
  return `<!doctype html><html lang="${esc(meta.lang)}"><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>${EXPORT_CSS}</style></head><body><h1>${esc(meta.title || (zh ? '无标题' : 'Untitled'))}</h1><div class="meta">${zh ? '学习于' : 'Learned'} ${fmtDate(meta.learnedAt, meta.lang)} · ${zh ? '积微' : 'Jiwei'}</div><div class="cornell">${rowsHtml}${sum}</div></body></html>`
}
