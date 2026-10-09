import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, Download, Loader2, ScanText, CheckCircle2, RotateCw } from 'lucide-react'
import type { SourceRecognition } from '@shared/types'
import { toast } from 'sonner'
import { api, cn, formatBytes } from '@/lib/utils'
import { useSettings } from '@/lib/queries'
import { Button } from '@/components/ui/button'

// 资料顶部的识别状态条（v0.5.2）：哪些页需要识别、下载本地模型、进度、失败重试。
// 没有需要识别的页时不显示。

/** 识别相关的查询：随主进程事件刷新 */
export function useRecognitionEvents(sourceId?: string): void {
  const qc = useQueryClient()
  useEffect(() => {
    const offs = [
      window.jiweiEvents.on('recognition:status', () => void qc.invalidateQueries({ queryKey: ['recognizer'] })),
      window.jiweiEvents.on('recognition:source', (p) => {
        if (!sourceId || p.sourceId === sourceId) void qc.invalidateQueries({ queryKey: ['recognition', p.sourceId] })
      })
    ]
    return () => offs.forEach((off) => off())
  }, [qc, sourceId])
}

export function RecognitionBar({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation()
  useRecognitionEvents(sourceId)
  // 识别设置变化（换引擎、开启插图解读）时重新计算
  const { data: settings } = useSettings()
  const { data: r } = useQuery({
    queryKey: ['recognition', sourceId, JSON.stringify(settings?.ai.recognition ?? null)],
    queryFn: () => api.recognition.source(sourceId),
    staleTime: 0
  })
  const { data: engine } = useQuery({ queryKey: ['recognizer'], queryFn: () => api.recognition.status() })
  if (!r || r.engine === 'off') return null
  const any = r.needs.scan + r.needs.table + r.needs.figure
  if (!any) return null

  const detail = (n: SourceRecognition['needs'], withFigures: boolean): string =>
    (withFigures ? (['scan', 'table', 'figure'] as const) : (['scan', 'table'] as const))
      .filter((k) => n[k])
      .map((k) => t(`workspace.recog.${k}`, { count: n[k] }))
      .join('、')
  const figuresIncluded = r.total > r.needs.scan + r.needs.table
  const start = (): void => void api.recognition.start(sourceId).catch((e: Error) => toast.error(e.message))

  let icon = <ScanText />
  let text: React.ReactNode
  let action: React.ReactNode = null
  let tone: 'muted' | 'warn' | 'ok' = 'muted'

  if (r.running) {
    icon = <Loader2 className="animate-spin" />
    text = t('workspace.recog.running', { done: r.done, total: r.total })
  } else if (r.engine === 'needs-install') {
    text = (
      <>
        {t('workspace.recog.pending', { count: r.needs.scan + r.needs.table, detail: detail(r.needs, false) })}
        <span className="text-subtle"> · {t('workspace.recog.needsInstall')}</span>
      </>
    )
    action =
      engine?.state === 'downloading' ? (
        <span className="text-2xs text-muted">{t('workspace.recog.installing', { percent: Math.floor(engine.progress * 100) })}</span>
      ) : (
        <Button size="sm" variant="outline" onClick={() => void api.recognition.install()}>
          <Download />
          {t('workspace.recog.install', { size: formatBytes(engine?.size ?? 0) })}
        </Button>
      )
  } else if (r.engine === 'no-vision-model' || r.engine === 'excluded') {
    tone = 'warn'
    icon = <CircleAlert />
    text = t(r.engine === 'excluded' ? 'workspace.recog.excluded' : 'workspace.recog.noVision')
  } else if (r.failed) {
    tone = 'warn'
    icon = <CircleAlert />
    text = t('workspace.recog.failed', { count: r.failed })
    action = (
      <Button size="sm" variant="outline" onClick={start}>
        <RotateCw />
        {t('workspace.recog.retry')}
      </Button>
    )
  } else if (r.done < r.total) {
    text = t('workspace.recog.pending', { count: r.total - r.done, detail: detail(r.needs, figuresIncluded) })
    action = (
      <Button size="sm" variant="outline" onClick={start}>
        <ScanText />
        {t('workspace.recog.start')}
      </Button>
    )
  } else if (r.total) {
    tone = 'ok'
    icon = <CheckCircle2 />
    text = t('workspace.recog.done', { count: r.done, detail: detail(r.needs, figuresIncluded) })
  }
  const figuresOff = !figuresIncluded && r.needs.figure > 0 && !r.running

  if (!text && !figuresOff) return null
  return (
    <div className="shrink-0 border-b border-border/70 bg-surface/70 px-4 py-2" data-testid="recognition-bar" role="status">
      {text && (
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'shrink-0 [&_svg]:size-3.5',
              tone === 'warn' ? 'text-[#b8862b]' : 'text-accent'
            )}
          >
            {icon}
          </span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">{text}</p>
          {action}
        </div>
      )}
      {figuresOff && <p className={cn('text-2xs leading-relaxed text-subtle', text && 'mt-1 pl-6')}>{t('workspace.recog.figuresOff', { count: r.needs.figure })}</p>}
    </div>
  )
}
