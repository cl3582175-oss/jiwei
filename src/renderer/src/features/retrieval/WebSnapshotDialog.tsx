import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, ExternalLink, Library, LoaderCircle, RefreshCw } from 'lucide-react'
import { api, cn, formatDate } from '@/lib/utils'
import { invalidate } from '@/lib/queries'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { snapshotParagraphs } from './snapshot'
import { useWebSnapshot } from './store'

function SnapshotContent({ pageId, locator, originalUrl }: { pageId: string; locator: string | null; originalUrl: string | null }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const body = useRef<HTMLDivElement>(null)
  const {
    data: page,
    isPending,
    isError,
    refetch
  } = useQuery({
    queryKey: ['retrieval', 'page', pageId],
    queryFn: () => api.retrieval.page(pageId),
    staleTime: 0,
    gcTime: 0,
    retry: false
  })
  const paragraphs = useMemo(() => snapshotParagraphs(page?.text ?? '', locator), [page?.text, locator])
  const save = useMutation({
    mutationFn: () => api.retrieval.savePage(pageId),
    onSuccess: ({ sourceId }) => {
      // 保存入口须和资料库导入一样刷新列表；已有网址复用时也刷新资料详情。
      invalidate(qc, 'sources', 'heatmap')
      void qc.invalidateQueries({ queryKey: ['source', sourceId] })
      toast.success(t('retrieval.snapshot.saveSuccess'), {
        action: {
          label: t('retrieval.snapshot.openSource'),
          onClick: () => {
            useWebSnapshot.getState().close()
            useApp.getState().openSource(sourceId)
          }
        }
      })
    },
    onError: () => toast.error(t('retrieval.snapshot.saveError'))
  })
  const copy = useMutation({
    mutationFn: (url: string) => navigator.clipboard.writeText(url),
    onSuccess: () => toast.success(t('retrieval.snapshot.copied')),
    onError: () => toast.error(t('retrieval.snapshot.copyError'))
  })
  useEffect(() => {
    const container = body.current
    const highlighted = container?.querySelector<HTMLElement>('[data-highlighted="true"]')
    if (!container || !highlighted) return
    // 等弹窗布局完成，再只滚动正文；不移动工作区或标题、操作栏。
    const frame = requestAnimationFrame(() => {
      const parent = container.getBoundingClientRect(),
        paragraph = highlighted.getBoundingClientRect()
      container.scrollTop += paragraph.top - parent.top - (container.clientHeight - paragraph.height) / 2
    })
    return () => cancelAnimationFrame(frame)
  }, [paragraphs, isError, isPending])
  const url = page?.url ?? originalUrl
  const openOriginal = (): void => {
    if (!url) return
    useApp.getState().openBrowser(url)
    useWebSnapshot.getState().close()
  }
  let site = page?.siteName
  if (page && !site) {
    try {
      site = new URL(page.url).hostname
    } catch {
      /* 存量快照的网址损坏时仍可读正文。 */
    }
  }

  return (
    <DialogContent
      title={<span className="block pr-6 font-serif text-lg leading-relaxed">{page?.title || t('retrieval.snapshot.title')}</span>}
      className="flex max-h-[80vh] w-[min(92vw,720px)] flex-col overflow-hidden"
    >
      <div className="mt-3 flex min-h-0 flex-1 flex-col" data-testid="web-snapshot" aria-busy={isPending}>
        {isPending ? (
          <p className="flex items-center gap-2 py-8 text-sm text-muted" role="status">
            <LoaderCircle className="size-4 animate-spin" />
            {t('retrieval.snapshot.loading')}
          </p>
        ) : isError ? (
          <div className="space-y-3 py-6" role="alert">
            <p className="text-sm text-muted">{t('retrieval.snapshot.error')}</p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              <RefreshCw />
              {t('retrieval.snapshot.retry')}
            </Button>
          </div>
        ) : page === null ? (
          <p className="py-8 text-sm text-muted" data-testid="web-snapshot-missing">
            {t('retrieval.snapshot.missing')}
          </p>
        ) : page ? (
          <>
            <p className="mb-4 flex shrink-0 flex-wrap gap-x-2 gap-y-1 text-2xs text-subtle" data-testid="web-snapshot-meta">
              <span>{site}</span>
              {page.publishedAt !== null && (
                <span>· {t('retrieval.snapshot.publishedAt', { date: formatDate(page.publishedAt, i18n.language) })}</span>
              )}
              <span>· {t('retrieval.snapshot.fetchedAt', { date: formatDate(page.fetchedAt, i18n.language) })}</span>
              <span>· {t('retrieval.snapshot.method', { method: t(`retrieval.snapshot.${page.method}`) })}</span>
            </p>
            <div ref={body} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" data-testid="web-snapshot-body">
              {paragraphs.map((paragraph) => (
                <p
                  key={paragraph.start}
                  className={cn(
                    'border-l-2 border-transparent px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words text-fg',
                    paragraph.highlighted && 'border-accent bg-accent-soft'
                  )}
                  data-highlighted={paragraph.highlighted ? 'true' : undefined}
                  data-char-start={paragraph.start}
                  data-char-end={paragraph.end}
                >
                  {paragraph.text}
                </p>
              ))}
            </div>
          </>
        ) : null}
        <div className="mt-4 flex shrink-0 flex-wrap justify-end gap-2 border-t border-border pt-3">
          <Button size="sm" variant="ghost" onClick={openOriginal} disabled={!url} data-testid="web-snapshot-open-original">
            <ExternalLink />
            {t('retrieval.snapshot.openOriginal')}
          </Button>
          {page && !isError && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copy.mutate(page.url)}
                disabled={copy.isPending}
                data-testid="web-snapshot-copy-url"
              >
                <Copy />
                {t('retrieval.snapshot.copyUrl')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={save.isPending} data-testid="web-snapshot-save">
                {save.isPending ? <LoaderCircle className="animate-spin" /> : <Library />}
                {t('retrieval.snapshot.save')}
              </Button>
            </>
          )}
        </div>
      </div>
    </DialogContent>
  )
}

export function WebSnapshotDialog() {
  const { pageId, locator, url, close } = useWebSnapshot()
  return (
    <Dialog open={!!pageId} onOpenChange={(open) => !open && close()}>
      {pageId && <SnapshotContent key={pageId} pageId={pageId} locator={locator} originalUrl={url} />}
    </Dialog>
  )
}
