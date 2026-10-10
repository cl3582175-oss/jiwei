import { emit, onMainEvent } from '../../events'
import { onAnnotationsChange } from '../annotations'
import { markInteraction, registerContentIpc, setDownloadHandler, setLoadedHandler, tabZoom } from './manager'
import { onAnnotationsChanged, onDownloaded, pushAnnotations, scheduleRelated } from './pages'
import type { BrowserAction } from '@shared/types'
import { registerCourse } from './course'
import { registerConceptIpc, pushConcepts, refreshConcepts } from './concepts'
import { registerReadingIpc, pushBrowserReading } from '../reading'

// 内置浏览器的启动注册（v0.6.0）：内容脚本消息、下载导入、页面加载后的高亮与相关笔记、批注变化同步。

const ACTIONS = new Set<BrowserAction['action']>([
  'explain',
  'clarify',
  'translate',
  'grammar',
  'ask',
  'highlighting',
  'commenting',
  'questioning',
  'annotation'
])
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function registerBrowser(): void {
  registerCourse()
  registerConceptIpc()
  registerReadingIpc()
  onMainEvent('memory:changed', refreshConcepts)
  registerContentIpc({
    // 来自网页的消息一律校验，只转发约定的字段
    action: (tabId, raw) => {
      const m = (raw ?? {}) as Record<string, unknown>
      const action = m.action as BrowserAction['action']
      if (!ACTIONS.has(action)) return
      const r = (m.rect ?? {}) as Record<string, unknown>,
        z = tabZoom(tabId)
      const msg: BrowserAction = {
        tabId,
        action,
        quote: str(m.quote, 4000),
        prefix: str(m.prefix, 200),
        suffix: str(m.suffix, 200),
        rect: { x: num(r.x) * z, y: num(r.y) * z, w: num(r.w) * z, h: num(r.h) * z },
        ...(typeof m.annotationId === 'string' ? { annotationId: m.annotationId.slice(0, 64) } : {})
      }
      if (action !== 'annotation' && !msg.quote) return
      if (action !== 'annotation') markInteraction(tabId)
      emit('browser:action', msg)
    },
    ready: (tabId) => {
      pushAnnotations(tabId)
      void pushConcepts(tabId)
      void pushBrowserReading(tabId)
    }
  })
  setLoadedHandler((tabId) => {
    pushAnnotations(tabId)
    scheduleRelated(tabId)
    void pushConcepts(tabId)
    void pushBrowserReading(tabId)
  })
  setDownloadHandler((path, name) => void onDownloaded(path, name))
  onAnnotationsChange((type, id) => onAnnotationsChanged(type, id))
}
