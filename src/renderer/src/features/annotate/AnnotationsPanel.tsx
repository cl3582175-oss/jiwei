import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { FileDown, X, CircleHelp, MessageSquare, Highlighter } from 'lucide-react'
import { toast } from 'sonner'
import type { Annotation, Segment } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { useAnnotate, useAnnotations } from './store'
import { SWATCH } from './AnnotationCard'
import { locateQuote } from './anchor'

// 资料的批注列表：按位置排序，可筛选（全部 / 评论 / 存疑），点击跳到原文；PDF 可导出带批注的文件。

type Filter = 'all' | 'comments' | 'questions'

const order = (a: Annotation, segIndex: Map<string, number>): number =>
  (a.selector.page ?? 0) * 1e6 +
  (a.selector.ownerId ? (segIndex.get(a.selector.ownerId) ?? 0) * 1e3 : 0) +
  (a.selector.rects?.[0]?.y ?? 0) * 1e3 +
  (a.selector.start ?? 0) / 1e6

export function AnnotationsPanel({ sourceId, isPdf, onClose }: { sourceId: string; isPdf: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const list = useAnnotations('source', sourceId)
  const { data: segs = [] } = useQuery({ queryKey: ['segments', sourceId], queryFn: () => api.segments.list(sourceId) })
  const [filter, setFilter] = useState<Filter>('all')

  const segIndex = useMemo(() => new Map(segs.map((s: Segment, i) => [s.id, i])), [segs])
  // 文字资料：原文在所有片段中都找不到的批注“失去定位”
  const orphans = useMemo(() => {
    if (isPdf || !segs.length) return new Set<string>()
    return new Set(list.filter((a) => a.selector.quote && !segs.some((s) => locateQuote(s.text, { ...a.selector, start: undefined }))).map((a) => a.id))
  }, [list, segs, isPdf])

  const shown = list
    .filter((a) => (filter === 'comments' ? !!a.body?.trim() : filter === 'questions' ? a.motivation === 'questioning' : true))
    .sort((a, b) => order(a, segIndex) - order(b, segIndex))

  const jump = (a: Annotation, el: HTMLElement): void => {
    const app = useApp.getState()
    app.setHighlight({
      type: 'segment',
      id: a.selector.ownerId ?? '',
      sourceId,
      selector: a.selector,
      locator: a.selector.page ? `page=${a.selector.page}` : null
    })
    // 跳转后打开卡片（定位到列表项旁）
    const b = el.getBoundingClientRect()
    if (a.body?.trim() || a.motivation !== 'highlighting')
      useAnnotate.getState().open({ id: a.id, targetType: 'source', targetId: sourceId, rect: { x: b.left - 330, y: b.top, w: 0, h: b.height }, edit: false })
  }

  const exportPdf = async (): Promise<void> => {
    try {
      const file = await api.annotations.exportPdf(sourceId)
      if (file) toast.success(t('annotate.exported'), { action: { label: t('annotate.reveal'), onClick: () => void api.app.showInFolder(file) } })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside
      aria-label={t('annotate.panel')}
      data-testid="annotations-panel"
      className="absolute inset-y-0 right-0 z-20 flex w-[300px] max-w-full flex-col border-l border-border bg-panel shadow-float"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <h3 className="flex-1 text-sm font-medium text-fg">
          {t('annotate.panel')} <span className="text-xs text-subtle">{list.length}</span>
        </h3>
        <Button size="icon-sm" variant="ghost" aria-label={t('common.close')} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="flex shrink-0 gap-1 px-3 pt-2.5" role="tablist">
        {(['all', 'comments', 'questions'] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-md px-2 py-1 text-xs transition-colors',
              filter === f ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
            )}
          >
            {t(`annotate.filter.${f}`)}
          </button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {shown.length === 0 && <li className="px-2 py-6 text-center text-xs leading-relaxed text-subtle">{t('annotate.empty')}</li>}
        {shown.map((a) => (
          <li key={a.id}>
            <button
              onClick={(e) => jump(a, e.currentTarget)}
              data-annotation={a.id}
              className="group flex w-full gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-hover"
            >
              <span className="mt-0.5 w-1 shrink-0 self-stretch rounded-full" style={{ background: SWATCH[a.color ?? 'yellow'] }} />
              <span className="min-w-0 flex-1">
                {a.selector.quote && <span className="line-clamp-2 block text-xs leading-relaxed text-muted">{a.selector.quote}</span>}
                {a.body && <span className="mt-1 line-clamp-3 block text-sm leading-relaxed text-fg">{a.body}</span>}
                <span className="mt-1 flex items-center gap-1.5 text-2xs text-subtle [&_svg]:size-3">
                  {a.motivation === 'questioning' ? <CircleHelp className="text-[#c0663a]" /> : a.body ? <MessageSquare /> : <Highlighter />}
                  {a.selector.page ? t('annotate.page', { n: a.selector.page }) : null}
                  {orphans.has(a.id) && <span className="rounded bg-danger-soft px-1 text-danger">{t('annotate.orphan')}</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {isPdf && list.length > 0 && (
        <footer className="shrink-0 border-t border-border/70 p-2">
          <Button size="sm" variant="ghost" className="w-full" onClick={() => void exportPdf()}>
            <FileDown />
            {t('annotate.exportPdf')}
          </Button>
        </footer>
      )}
    </aside>
  )
}
