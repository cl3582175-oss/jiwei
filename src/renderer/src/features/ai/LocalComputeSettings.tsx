import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, Download, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ComputeMode, ComputeServiceStatus } from '@shared/localCompute'
import { Button } from '@/components/ui/button'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { api, formatBytes } from '@/lib/utils'

const errText = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function ServiceRow({ status }: { status: ComputeServiceStatus }) {
  const { t } = useTranslation()
  let label: string
  if (status.state === 'idle') label = t('localCompute.idle')
  else if (status.state === 'starting') label = t('localCompute.starting')
  else if (status.state === 'error') label = status.reason ?? t('localCompute.unknown')
  else if ((status.offloadedLayers ?? 0) > 0) {
    const layers =
      status.totalLayers && status.offloadedLayers === status.totalLayers
        ? t('localCompute.allGpu')
        : status.totalLayers
          ? t('localCompute.partial', { used: status.offloadedLayers, total: status.totalLayers })
          : t('localCompute.gpuLayers', { used: status.offloadedLayers })
    label = [status.device ?? t('localCompute.gpu'), status.backend?.toUpperCase(), layers].filter(Boolean).join(' · ')
  } else if (status.backend === 'cpu' || status.mode === 'cpu') label = t('localCompute.cpu')
  else label = t('localCompute.unknown')
  return (
    <div className="space-y-1" data-testid={`local-compute-${status.service}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-muted">{t(`localCompute.${status.service}`)}</span>
        <span className="break-words text-xs text-fg">{label}</span>
      </div>
      {status.reason && status.state !== 'error' ? <p className="break-words text-2xs text-subtle">{status.reason.slice(-400)}</p> : null}
    </div>
  )
}

export function LocalComputeSettings() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: settings } = useSettings()
  const update = useUpdateSettings()
  const [busy, setBusy] = useState<'redetect' | 'retryCuda' | 'removeCuda' | null>(null)
  const query = useQuery({
    queryKey: ['local-compute'],
    queryFn: () => api.localCompute.status(),
    refetchInterval: (q) => (q.state.data?.runtime.downloading || q.state.data?.maintenance ? 1000 : false)
  })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.jiweiEvents.on('local-compute:changed', () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void qc.invalidateQueries({ queryKey: ['local-compute'] })
      }, 150)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [qc])
  if (!settings) return null
  const status = query.data
  const active = !!busy || !!status?.maintenance
  const action = async (name: NonNullable<typeof busy>): Promise<void> => {
    setBusy(name)
    try {
      await api.localCompute[name]()
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ['local-compute'] })
      void qc.invalidateQueries({ queryKey: ['embedding'] })
      void qc.invalidateQueries({ queryKey: ['recognizer'] })
    }
  }
  const cuda = status?.cuda
  const showCuda = cuda && (cuda.supported || cuda.installedBytes > 0 || cuda.failures > 0)
  return (
    <section className="space-y-3" data-testid="local-compute-settings">
      <h4 className="flex items-center gap-2 text-sm font-medium text-fg">
        <Cpu className="size-4 text-accent" />
        {t('localCompute.title')}
      </h4>
      <p className="text-xs leading-relaxed text-muted">{t('localCompute.description')}</p>
      <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-xs text-fg" htmlFor="local-compute-mode">
            {t('localCompute.label')}
          </label>
          <select
            id="local-compute-mode"
            className="h-8 max-w-full rounded-md border border-border bg-sunken px-2 text-xs text-fg"
            value={settings.ai.localCompute ?? 'auto'}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate(
                { ai: { ...settings.ai, localCompute: e.target.value as ComputeMode } },
                {
                  onError: (error) => {
                    toast.error(errText(error))
                    void qc.invalidateQueries({ queryKey: ['settings'] })
                  }
                }
              )
            }
          >
            <option value="auto">{t('localCompute.auto')}</option>
            <option value="cpu">{t('localCompute.cpuOnly')}</option>
          </select>
        </div>
        {status ? (
          <>
            {!status.supported ? <p className="text-xs text-muted">{t('localCompute.unsupported')}</p> : null}
            <ServiceRow status={status.services.embedding} />
            <ServiceRow status={status.services.recognition} />
            {status.pendingRestart ? <p className="text-2xs text-muted">{t('localCompute.pending')}</p> : null}
            {status.benchmark.state === 'pending' ? <p className="text-2xs text-subtle">{t('localCompute.benchmarkPending')}</p> : null}
            {status.benchmark.state === 'cpu' ? <p className="text-2xs text-subtle">{t('localCompute.benchmarkCpu')}</p> : null}
            {status.benchmark.state === 'failed' ? <p className="text-2xs text-subtle">{t('localCompute.benchmarkFailed')}</p> : null}
            {status.runtime.downloading ? (
              <div className="space-y-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                  <div
                    className="h-full bg-accent transition-[width]"
                    style={{
                      width: `${Math.min(100, status.runtime.totalBytes ? (status.runtime.receivedBytes / status.runtime.totalBytes) * 100 : 0)}%`
                    }}
                  />
                </div>
                <p className="text-2xs text-subtle">
                  {t('localCompute.runtimeDownload', {
                    received: formatBytes(status.runtime.receivedBytes),
                    total: formatBytes(status.runtime.totalBytes)
                  })}
                </p>
              </div>
            ) : null}
            {status.runtime.error ? <p className="break-words text-2xs text-danger">{status.runtime.error}</p> : null}
          </>
        ) : query.error ? (
          <p className="text-2xs text-danger">{errText(query.error)}</p>
        ) : (
          <Loader2 className="size-4 animate-spin text-subtle" />
        )}
        <Button size="sm" variant="ghost" disabled={active || query.isPending} onClick={() => void action('redetect')}>
          {busy === 'redetect' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t('localCompute.redetect')}
        </Button>
        {showCuda ? (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="flex justify-between gap-3 text-xs text-muted">
              <span>{t('localCompute.cudaStorage')}</span>
              <span>{formatBytes(cuda.installedBytes)}</span>
            </p>
            {cuda.disabled ? <p className="text-2xs text-subtle">{t('localCompute.cudaDisabled')}</p> : null}
            {cuda.retryBlocked ? <p className="text-2xs text-muted">{t('localCompute.retryStopped')}</p> : null}
            {cuda.reason ? <p className="break-words text-2xs text-subtle">{cuda.reason}</p> : null}
            <div className="flex flex-wrap gap-2">
              {cuda.supported && (cuda.failures > 0 || cuda.disabled || cuda.retryBlocked) ? (
                <Button size="sm" disabled={active} onClick={() => void action('retryCuda')}>
                  <Download />
                  {t('localCompute.cudaRetry')}
                  {cuda.downloadBytes > 0 ? ` (${formatBytes(cuda.downloadBytes)})` : ''}
                </Button>
              ) : null}
              {cuda.installedBytes > 0 ? (
                <Button size="sm" variant="ghost" disabled={active} onClick={() => void action('removeCuda')}>
                  <Trash2 />
                  {t('localCompute.cudaRemove')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
