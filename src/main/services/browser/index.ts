import { emit } from '../../events'
import { onAnnotationsChange } from '../annotations'
import { markInteraction, registerContentIpc, setDownloadHandler, setLoadedHandler } from './manager'
import { onAnnotationsChanged, onDownloaded, pushAnnotations, scheduleRelated } from './pages'
import type { BrowserAction } from '@shared/types'

// 内置浏览器的启动注册（v0.6.0）：内容脚本消息、下载导入、页面加载后的高亮与相关笔记、批注变化同步。

const ACTIONS = new Set<BrowserAction['action']>(['explain', 'clarify', 'translate', 'ask', 'highlighting', 'commenting', 'questioning', 'annotation'])
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function registerBrowser(): void {
  registerContentIpc({
    // 来自网页的消息一律校验，只转发约定的字段
    action: (tabId, raw) => {
      const m = (raw ?? {}) as Record<string, unknown>
      const action = m.action as BrowserAction['action']
      if (!ACTIONS.has(action)) return
      const r = (m.rect ?? {}) as Record<string, unknown>
      const msg: BrowserAction = {
        tabId,
        action,
        quote: str(m.quote, 4000),
        prefix: str(m.prefix, 200),
        suffix: str(m.suffix, 200),
        rect: { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) },
        ...(typeof m.annotationId === 'string' ? { annotationId: m.annotationId.slice(0, 64) } : {})
      }
      if (action !== 'annotation' && !msg.quote) return
      if (action !== 'annotation') markInteraction(tabId)
      emit('browser:action', msg)
    },
    ready: (tabId) => pushAnnotations(tabId)
  })
  setLoadedHandler((tabId) => {
    pushAnnotations(tabId)
    scheduleRelated(tabId)
  })
  setDownloadHandler((path, name) => void onDownloaded(path, name))
  onAnnotationsChange((type, id) => onAnnotationsChanged(type, id))
}
