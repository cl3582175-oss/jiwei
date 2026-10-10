/// <reference lib="dom.iterable" />
/// <reference lib="dom" />
import { ipcRenderer } from 'electron'
import { configureVideo, startBrowserVideo } from './browserVideo'
import type { CourseState } from '../shared/types'
import { startConcepts } from './browserConcepts'

// 内置浏览器的内容脚本（v0.6.0）：运行在网页的隔离环境中（contextIsolation），网页本身的脚本无法访问。
//   - 选区浮条：解释 / 讲明白 / 翻译 / 问 AI / 高亮 / 批注 / 存疑（Shadow DOM，不受网页样式影响）
//   - 高亮：按原文与前后文（W3C TextQuote）定位，用 CSS Custom Highlight API 绘制，不改动网页 DOM
//   - 报告密码输入框（敏感页面自动关闭 AI）
// 不向网页暴露任何接口（不调用 contextBridge）。

type Action = 'explain' | 'clarify' | 'translate' | 'ask' | 'highlighting' | 'commenting' | 'questioning' | 'annotation'
interface Config {
  allowed: boolean
  labels: Record<Exclude<Action, 'annotation'>, string>
  scope: string
  course: CourseState
}
interface Ann {
  id: string
  quote: string
  prefix: string
  suffix: string
  color: string
  question: boolean
  note: boolean
}

const CONTEXT = 32
let config: Config | null = null
const concepts = startConcepts(
  () => !!config?.allowed,
  () => config?.labels.ask ?? ''
)
let host: HTMLElement | null = null
let bar: HTMLElement | null = null
let ranges: { id: string; range: Range }[] = []

/* ——— 敏感页面：密码输入框 ——— */

let passwordReported = false
function visiblePassword(el: HTMLInputElement): boolean {
  const r = el.getBoundingClientRect(),
    style = getComputedStyle(el)
  return r.width > 2 && r.height > 2 && el.getClientRects().length > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0.05
}
function checkPassword(): void {
  // 只看用户真正看得见的密码框：很多网站预埋了隐藏的登录弹窗，不能因此把整页的 AI 与网课关掉
  if (passwordReported || ![...document.querySelectorAll<HTMLInputElement>('input[type=password]')].some(visiblePassword)) return
  passwordReported = true
  ipcRenderer.send('jw-page:password')
  // 敏感页面：立即关闭浮条
  if (config) config.allowed = false
  if (config) configureVideo(config)
  concepts.clear()
  hideBar()
}

/* ——— 选区浮条 ——— */

function ensureBar(): HTMLElement {
  if (bar && host?.isConnected) return bar
  host = document.createElement('jiwei-toolbar')
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;'
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    .bar { display: none; position: fixed; align-items: center; gap: 2px; padding: 4px; border-radius: 12px;
      background: rgba(255,255,255,.96); border: 1px solid rgba(0,0,0,.08); box-shadow: 0 8px 28px rgba(16,40,44,.18);
      font: 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1d2b2e; }
    .bar.show { display: flex; }
    button { all: unset; cursor: pointer; padding: 7px 9px; border-radius: 8px; white-space: nowrap; }
    button:hover { background: rgba(31,96,104,.10); color: #1f6068; }
    .sep { width: 1px; height: 18px; background: rgba(0,0,0,.1); margin: 0 2px; }
    @media (prefers-color-scheme: dark) {
      .bar { background: rgba(28,36,38,.96); border-color: rgba(255,255,255,.1); color: #e4ecec; }
      button:hover { background: rgba(120,190,196,.16); color: #9fd3d8; }
    }`
  bar = document.createElement('div')
  bar.className = 'bar'
  bar.setAttribute('role', 'toolbar')
  const groups: Exclude<Action, 'annotation'>[][] = [
    ['explain', 'clarify', 'translate', 'ask'],
    ['highlighting', 'commenting', 'questioning']
  ]
  groups.forEach((g, i) => {
    if (i) {
      const sep = document.createElement('span')
      sep.className = 'sep'
      bar!.appendChild(sep)
    }
    for (const a of g) {
      const b = document.createElement('button')
      b.textContent = config?.labels[a] ?? a
      b.dataset.action = a
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => fire(a))
      bar!.appendChild(b)
    }
  })
  root.append(style, bar)
  document.documentElement.appendChild(host)
  return bar
}

function hideBar(): void {
  bar?.classList.remove('show')
}

/** 选区的原文、前后文与位置 */
function selectionInfo(): { quote: string; prefix: string; suffix: string; rect: DOMRect } | null {
  const sel = getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  const quote = sel.toString().replace(/\s+/g, ' ').trim()
  if (!quote || quote.length > 4000) return null
  const body = document.body
  const pre = document.createRange()
  pre.setStart(body, 0)
  pre.setEnd(range.startContainer, range.startOffset)
  const post = document.createRange()
  post.setStart(range.endContainer, range.endOffset)
  post.setEnd(body, body.childNodes.length)
  const norm = (s: string): string => s.replace(/\s+/g, ' ')
  return {
    quote,
    prefix: norm(pre.toString()).slice(-CONTEXT),
    suffix: norm(post.toString()).slice(0, CONTEXT),
    rect: range.getBoundingClientRect()
  }
}

function fire(action: Exclude<Action, 'annotation'>): void {
  const info = selectionInfo()
  hideBar()
  if (!info) return
  const r = info.rect
  ipcRenderer.send('jw-page:action', {
    action,
    quote: info.quote,
    prefix: info.prefix,
    suffix: info.suffix,
    rect: { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  if (action === 'highlighting' || action === 'commenting' || action === 'questioning') getSelection()?.removeAllRanges()
}

function onMouseUp(e: MouseEvent): void {
  if (!config?.allowed) return
  if (host && e.composedPath().includes(host)) return
  setTimeout(() => {
    const info = selectionInfo()
    if (!info) {
      hideBar()
      hitHighlight(e.clientX, e.clientY)
      return
    }
    const b = ensureBar()
    b.classList.add('show')
    const w = b.offsetWidth || 420
    const left = Math.min(Math.max(8, info.rect.left + info.rect.width / 2 - w / 2), innerWidth - w - 8)
    const top = info.rect.top > 48 ? info.rect.top - 44 : info.rect.bottom + 8
    b.style.left = `${left}px`
    b.style.top = `${top}px`
    // 各按钮的位置（只有坐标，便于自动化测试用真实点击验证；不暴露任何接口）
    host?.setAttribute(
      'data-buttons',
      JSON.stringify(
        [...b.querySelectorAll('button')].map((x) => {
          const r = x.getBoundingClientRect()
          return { action: x.dataset.action, x: r.left + r.width / 2, y: r.top + r.height / 2 }
        })
      )
    )
  }, 0)
}

/* ——— 高亮 ——— */

/** 网页正文的文字节点与偏移（与 Range.toString() 计数一致，空白归一） */
function textIndex(): { text: string; nodes: { node: Text; start: number; raw: string }[] } {
  const nodes: { node: Text; start: number; raw: string }[] = []
  let text = ''
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) || p.closest('jiwei-toolbar')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push({ node: n, start: text.length, raw: n.data })
    text += n.data
  }
  return { text, nodes }
}

/** 空白不敏感地查找原文：返回原始文本中的起止位置 */
function locate(text: string, a: Ann): [number, number] | null {
  // 把原文转成空白宽松的正则
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  let re: RegExp
  try {
    re = new RegExp(esc(a.quote.trim()), 'g')
  } catch {
    return null
  }
  const norm = (s: string): string => s.replace(/\s+/g, ' ')
  let best: [number, number] | null = null
  let bestScore = -1
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = norm(text.slice(Math.max(0, m.index - a.prefix.length * 2), m.index)).slice(-a.prefix.length)
    const after = norm(text.slice(m.index + m[0].length, m.index + m[0].length + a.suffix.length * 2)).slice(0, a.suffix.length)
    let score = 0
    while (score < before.length && before[before.length - 1 - score] === a.prefix[a.prefix.length - 1 - score]) score++
    let s2 = 0
    while (s2 < after.length && after[s2] === a.suffix[s2]) s2++
    if (score + s2 > bestScore) {
      bestScore = score + s2
      best = [m.index, m.index + m[0].length]
    }
    if (m[0].length === 0) re.lastIndex++
  }
  return best
}

function toRange(idx: ReturnType<typeof textIndex>, start: number, end: number): Range | null {
  const r = document.createRange()
  let started = false
  for (const n of idx.nodes) {
    const nEnd = n.start + n.raw.length
    if (!started && start < nEnd) {
      r.setStart(n.node, start - n.start)
      started = true
    }
    if (started && end <= nEnd) {
      r.setEnd(n.node, end - n.start)
      return r
    }
  }
  return null
}

const COLORS: Record<string, string> = { yellow: '#f6d75e', green: '#9fd8a4', blue: '#9cc6f2', pink: '#f4a9c4' }
let styled = false

function paint(items: Ann[]): void {
  const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  if (!reg || typeof Highlight === 'undefined') return
  if (!styled) {
    const st = document.createElement('style')
    st.textContent =
      Object.entries(COLORS)
        .map(([k, c]) => `::highlight(jw-${k}) { background-color: ${c}88; }`)
        .join('\n') + '\n::highlight(jw-question) { text-decoration: underline wavy #c0663a; text-underline-offset: 3px; }'
    ;(document.head || document.documentElement).appendChild(st)
    styled = true
  }
  const idx = textIndex()
  const groups = new Map<string, Range[]>()
  ranges = []
  for (const a of items) {
    if (!a.quote) continue
    const pos = locate(idx.text, a)
    const r = pos && toRange(idx, pos[0], pos[1])
    if (!r) continue
    ranges.push({ id: a.id, range: r })
    const key = `jw-${COLORS[a.color] ? a.color : 'yellow'}`
    groups.set(key, [...(groups.get(key) ?? []), r])
    if (a.question) groups.set('jw-question', [...(groups.get('jw-question') ?? []), r])
  }
  for (const k of ['jw-yellow', 'jw-green', 'jw-blue', 'jw-pink', 'jw-question']) {
    const rs = groups.get(k)
    if (rs?.length) reg.set(k, new Highlight(...rs))
    else reg.delete(k)
  }
}

/** 单击高亮：打开批注卡片 */
function hitHighlight(x: number, y: number): void {
  for (const { id, range } of ranges)
    for (const r of range.getClientRects())
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const b = range.getBoundingClientRect()
        ipcRenderer.send('jw-page:action', {
          action: 'annotation',
          annotationId: id,
          quote: '',
          prefix: '',
          suffix: '',
          rect: { x: b.left, y: b.top, w: b.width, h: b.height }
        })
        return
      }
}

/* ——— 启动 ——— */

let lastItems: Ann[] = []
ipcRenderer.on('jw-page:annotations', (_e, p: { items: Ann[] }) => {
  lastItems = p.items
  if (document.body) paint(lastItems)
})

window.addEventListener('DOMContentLoaded', () => {
  startBrowserVideo()
  checkPassword()
  // 弹窗显示时网站通常只改 class / style；节流后再查，弹幕等频繁变动的页面也不受拖累
  let pending = 0
  new MutationObserver(() => {
    if (passwordReported || pending) return
    pending = window.setTimeout(() => {
      pending = 0
      checkPassword()
    }, 300)
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'class', 'style', 'hidden']
  })
  // 焦点进入密码框：无论是否判断为可见，立即视为敏感
  document.addEventListener(
    'focusin',
    (e) => {
      if (passwordReported || !(e.target instanceof HTMLInputElement) || e.target.type !== 'password') return
      passwordReported = true
      ipcRenderer.send('jw-page:password')
      if (config) {
        config.allowed = false
        configureVideo(config)
      }
    },
    true
  )
  void (ipcRenderer.invoke('jw-page:config') as Promise<Config>).then((c) => {
    config = c
    if (passwordReported) config.allowed = false
    configureVideo(config)
    concepts.refresh()
  })
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hideBar(), true)
  window.addEventListener('scroll', hideBar, true)
  ipcRenderer.send('jw-page:ready')
})

ipcRenderer.on('jw-page:config-update', (_e, c: Config) => {
  config = c
  if (passwordReported) config.allowed = false
  configureVideo(config)
  concepts.refresh()
  if (!config.allowed) hideBar()
})

// 动态内容加载后重新定位高亮（节流）
let repaintTimer = 0
window.addEventListener('load', () => {
  new MutationObserver(() => {
    if (!lastItems.length) return
    clearTimeout(repaintTimer)
    repaintTimer = window.setTimeout(() => paint(lastItems), 800)
  }).observe(document.body, { childList: true, subtree: true, characterData: true })
})
