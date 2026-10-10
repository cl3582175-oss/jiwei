import { Fragment, useMemo } from 'react'
import { Streamdown } from 'streamdown'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { cn } from '@/lib/utils'

const PIECES = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$(?:\\.|[^$\n])+\$|\\\([\s\S]*?\\\)|!\[[^\]]*\]\(jiwei:\/\/asset\/[0-9a-f]{64}\.[a-z0-9]+\))/g
const IMAGE = /^!\[([^\]]*)\]\((jiwei:\/\/asset\/[0-9a-f]{64}\.[a-z0-9]+)\)$/

function math(part: string, plain: boolean): string | null {
  const block = part.startsWith('$$') || part.startsWith('\\[')
  if (!block && !part.startsWith('$') && !part.startsWith('\\(')) return null
  const wide = block || part.startsWith('\\(')
  return katex.renderToString(part.slice(wide ? 2 : 1, -(wide ? 2 : 1)), { displayMode: block && !plain, throwOnError: false, trust: false, maxExpand: 1000 })
}

/** 继续使用现有安全Markdown渲染；公式由禁用trust的KaTeX独立渲染。
 *  plain：列表摘要用，不分段、不出图，整段作为一行行内文字（可配合 line-clamp）。 */
export function RichMistake({ text, className, plain = false }: { text: string; className?: string; plain?: boolean }) {
  const paragraphs = useMemo(() => (plain ? [text.replace(/\s+/g, ' ')] : text.split(/\n{2,}/)).map((p) => p.split(PIECES)), [text, plain])
  if (plain) return <p className={cn('min-w-0 break-words', className)}>{paragraphs[0].map((part, i) => {
    if (IMAGE.test(part)) return null
    const html = math(part, true)
    return html ? <span key={i} className="katex-inline" dangerouslySetInnerHTML={{ __html: html }} /> : <Fragment key={i}>{part}</Fragment>
  })}</p>
  return <div className={cn('chat-md min-w-0 space-y-3 break-words text-sm leading-relaxed [&_img]:max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto', className)}>
    {paragraphs.map((parts, p) => <div key={p} className="whitespace-pre-line">{parts.map((part, i) => {
      const image = IMAGE.exec(part)
      if (image) return <img key={i} src={image[2]} alt={image[1]} className="my-3 max-h-80 rounded-lg object-contain" />
      const html = math(part, false)
      if (html) {
        const block = part.startsWith('$$') || part.startsWith('\\[')
        return <span key={i} className={block ? 'my-2 block max-w-full overflow-x-auto' : 'inline-block max-w-full overflow-x-auto align-middle'} dangerouslySetInnerHTML={{ __html: html }} />
      }
      if (!part.trim()) return part ? <Fragment key={i}>{' '}</Fragment> : null
      // Streamdown 会去掉首尾空白：公式两侧的空格单独补回，否则 “Solve $x$” 会粘成 “Solvex”。
      return <Fragment key={i}>{/^\s/.test(part) && ' '}<Streamdown mode="static" className="contents" controls={{ code: false, table: false, mermaid: false }} components={{ p: ({ children }) => <span>{children}</span> }}>{part.trim()}</Streamdown>{/\s$/.test(part) && ' '}</Fragment>
    })}</div>)}
  </div>
}
