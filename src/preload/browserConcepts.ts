/// <reference lib="dom.iterable" />
/// <reference lib="dom" />
import { ipcRenderer } from 'electron'
import { visibleReadingPassword } from '../shared/readingText'
import { findConceptMatches } from '@shared/conceptMatch'

interface Hit {
  name: string
  range: Range
  prefix: string
  suffix: string
}

interface TextIndex {
  text: string
  nodes: { node: Text; start: number; end: number }[]
}

const SKIP =
  'script,style,noscript,template,form,input,textarea,select,button,nav,[hidden],[aria-hidden="true"],[data-jiwei-ui],[contenteditable]:not([contenteditable="false"]),jiwei-toolbar,jiwei-concept'
const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,pre,section,div'

/** 只索引正文；块之间加边界，避免把相邻段落尾首拼成一个不存在的概念。 */
function textIndex(): TextIndex {
  const root = document.querySelector('article, main, [role=main]') ?? document.body
  const index: TextIndex = { text: '', nodes: [] }
  if (!root) return index
  let block: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      return !parent || parent.closest(SKIP) || !parent.getClientRects().length ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    }
  })
  for (
    let node = walker.nextNode() as Text | null;
    node && index.text.length < 120_000 && index.nodes.length < 6000;
    node = walker.nextNode() as Text | null
  ) {
    const nextBlock = node.parentElement?.closest(BLOCK) ?? null
    if (block && nextBlock !== block) index.text += '\u0000'
    block = nextBlock
    const start = index.text.length
    index.text += node.data.slice(0, 120_000 - start)
    index.nodes.push({ node, start, end: index.text.length })
  }
  return index
}

function rangeAt(index: TextIndex, start: number, end: number): Range | null {
  const first = index.nodes.find((item) => item.start <= start && item.end > start)
  const last = index.nodes.find((item) => item.start < end && item.end >= end)
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, start - first.start)
  range.setEnd(last.node, end - last.start)
  return range
}

/** 内容脚本始终留在隔离环境；提示中的“问 AI”发送与选区浮条相同的 action 消息。 */
export function startConcepts(allowed: () => boolean, askLabel: () => string): { refresh: () => void; clear: () => void } {
  let names: string[] = []
  let pageUrl = ''
  let hits: Hit[] = []
  let current: Hit | null = null
  let hoverTimer = 0
  let hideTimer = 0
  let repaintTimer = 0
  let pointerFrame = 0
  let request = 0
  let passwordReported = false
  let host: HTMLElement | null = null
  let style: HTMLStyleElement | null = null

  const registry = (): Map<string, unknown> | undefined => (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  const hasPassword = (): boolean => [...document.querySelectorAll('input[type=password]')].some(visibleReadingPassword)
  const eligible = (): boolean => allowed() && !hasPassword() && pageUrl === location.href

  const hide = (): void => {
    clearTimeout(hoverTimer)
    clearTimeout(hideTimer)
    hoverTimer = 0
    request++
    current = null
    host?.remove()
    host = null
  }

  const clear = (): void => {
    hide()
    clearTimeout(repaintTimer)
    repaintTimer = 0
    cancelAnimationFrame(pointerFrame)
    pointerFrame = 0
    names = []
    hits = []
    pageUrl = ''
    registry()?.delete('jw-concept')
  }

  const paint = (): void => {
    hide()
    hits = []
    registry()?.delete('jw-concept')
    if (!eligible()) return clear()
    if (!names.length || !registry() || typeof Highlight === 'undefined' || !document.body) return
    if (!style?.isConnected) {
      style = document.createElement('style')
      style.textContent =
        '::highlight(jw-concept) { text-decoration: underline dashed color-mix(in srgb, currentColor 36%, transparent); text-underline-offset: 3px; }'
      ;(document.head || document.documentElement).appendChild(style)
    }
    const index = textIndex()
    for (const match of findConceptMatches(index.text, names)) {
      const range = rangeAt(index, match.start, match.end)
      if (range)
        hits.push({
          name: match.name,
          range,
          prefix: index.text.slice(Math.max(0, match.start - 32), match.start).replaceAll('\u0000', '\n'),
          suffix: index.text.slice(match.end, match.end + 32).replaceAll('\u0000', '\n')
        })
    }
    if (hits.length) registry()?.set('jw-concept', new Highlight(...hits.map((hit) => hit.range)))
  }

  const show = (hit: Hit, text: string): void => {
    if (!eligible() || current !== hit || !hit.range.startContainer.isConnected) return
    host?.remove()
    host = document.createElement('jiwei-concept')
    host.setAttribute('data-jiwei-ui', 'concept')
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; color-scheme: light dark;'
    const shadow = host.attachShadow({ mode: 'closed' })
    const css = document.createElement('style')
    css.textContent = `
      :host { --jw-bg: Canvas; --jw-fg: CanvasText; --jw-accent: LinkText; --jw-border: color-mix(in srgb, CanvasText 18%, transparent); }
      .tip { position: fixed; box-sizing: border-box; width: min(300px, calc(100vw - 16px)); padding: 12px;
        border: 1px solid var(--jw-border); border-radius: 10px; background: var(--jw-bg); color: var(--jw-fg);
        box-shadow: 0 4px 20px var(--jw-border); font: 12px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
      strong { display: block; margin-bottom: 4px; font-weight: 600; }
      p { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
      button { all: unset; cursor: pointer; color: var(--jw-accent); border-radius: 5px; padding: 3px 6px; }
      button:hover, button:focus-visible { background: color-mix(in srgb, var(--jw-accent) 10%, transparent); outline: 1px solid var(--jw-accent); }
    `
    const tip = document.createElement('div')
    tip.className = 'tip'
    tip.setAttribute('role', 'dialog')
    tip.setAttribute('aria-label', hit.name)
    const title = document.createElement('strong')
    title.textContent = hit.name
    const body = document.createElement('p')
    body.textContent = text.slice(0, 200)
    const ask = document.createElement('button')
    ask.textContent = askLabel()
    ask.setAttribute('aria-label', askLabel())
    ask.title = askLabel()
    ask.addEventListener('click', () => {
      if (!eligible() || current !== hit || !hit.range.startContainer.isConnected) return clear()
      const rect = hit.range.getBoundingClientRect()
      ipcRenderer.send('jw-page:action', {
        action: 'ask',
        quote: hit.range.toString().replace(/\s+/g, ' ').trim(),
        prefix: hit.prefix,
        suffix: hit.suffix,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      })
      hide()
    })
    tip.append(title, body, ask)
    shadow.append(css, tip)
    document.documentElement.appendChild(host)
    const rect = hit.range.getBoundingClientRect()
    tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tip.offsetWidth - 8))}px`
    tip.style.top = `${Math.max(8, rect.bottom + tip.offsetHeight + 10 <= innerHeight ? rect.bottom + 6 : rect.top - tip.offsetHeight - 6)}px`
    // 与现有浮条一致，仅给端到端测试公开按钮坐标，不公开笔记内容或调用接口。
    const button = ask.getBoundingClientRect()
    host.setAttribute('data-ask', JSON.stringify({ x: button.left + button.width / 2, y: button.top + button.height / 2 }))
  }

  const hover = (hit: Hit): void => {
    if (hit === current) return
    hide()
    current = hit
    const generation = request
    hoverTimer = window.setTimeout(() => {
      if (!eligible() || current !== hit) return clear()
      void ipcRenderer
        .invoke('jw-page:describe-concept', { name: hit.name, url: pageUrl })
        .then((raw: unknown) => {
          if (request !== generation || !raw || typeof raw !== 'object' || !('text' in raw) || typeof raw.text !== 'string') return
          show(hit, raw.text)
        })
        .catch(() => {
          if (request === generation) hide()
        })
    }, 600)
  }

  const refresh = (): void => {
    if (!allowed() || hasPassword()) return clear()
    ipcRenderer.send('jw-page:concepts-ready', { url: location.href })
  }

  ipcRenderer.on('jw-page:concepts', (_event, raw: unknown) => {
    clear()
    if (
      !allowed() ||
      !raw ||
      typeof raw !== 'object' ||
      !('url' in raw) ||
      raw.url !== location.href ||
      !('names' in raw) ||
      !Array.isArray(raw.names)
    )
      return
    names = [...new Set(raw.names.filter((name): name is string => typeof name === 'string' && !!name.trim() && name.length <= 40))].slice(
      0,
      50
    )
    pageUrl = raw.url
    if (document.body) paint()
  })

  const start = (): void => {
    new MutationObserver((records) => {
      if (hasPassword()) {
        clear()
        if (!passwordReported) {
          passwordReported = true
          ipcRenderer.send('jw-page:password')
        }
        return
      }
      if (!names.length) return
      if (!eligible()) return clear()
      if (records.every((record) => record.target instanceof Element && !!record.target.closest('jiwei-concept'))) return
      hide()
      clearTimeout(repaintTimer)
      repaintTimer = window.setTimeout(paint, 600)
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      // 登录组件可把既有文本框改成密码框；只监听新增节点会错过这次隐私边界变化。
      attributes: true,
      attributeFilter: ['type', 'hidden', 'aria-hidden', 'class', 'style', 'contenteditable']
    })
    document.addEventListener(
      'mousemove',
      (event) => {
        cancelAnimationFrame(pointerFrame)
        if (host && event.composedPath().includes(host)) {
          clearTimeout(hideTimer)
          return
        }
        pointerFrame = requestAnimationFrame(() => {
          if (!eligible()) return clear()
          const hit = hits.find((candidate) =>
            [...candidate.range.getClientRects()].some(
              (rect) =>
                event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
            )
          )
          if (hit) {
            clearTimeout(hideTimer)
            hover(hit)
          } else if (!host) hide()
          else {
            // 提示框与下划线间留有间隙，短暂经过时不立即移除，让按钮能够被点击。
            clearTimeout(hideTimer)
            hideTimer = window.setTimeout(hide, 250)
          }
        })
      },
      true
    )
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') hide()
      },
      true
    )
    document.addEventListener('mouseleave', hide)
    document.addEventListener(
      'mousedown',
      (event) => {
        if (!host || !event.composedPath().includes(host)) hide()
      },
      true
    )
    window.addEventListener('scroll', hide, true)
    window.addEventListener('pagehide', clear)
    refresh()
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
  return { refresh, clear }
}
