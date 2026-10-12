import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { pluginError } from './PluginConfirmDialog'

export const MANIM_ID = 'manim@jiwei'
const size = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`)

export function useManimStatus() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['manim'], queryFn: () => api.manim.status() })
  useEffect(() => window.jiweiEvents.on('plugins:changed', () => void qc.invalidateQueries({ queryKey: ['manim'] })), [qc])
  return q
}

/** 已安装列表里的一行提示：运行环境还没下载 */
export function ManimRowHint() {
  const { t } = useTranslation()
  const { data } = useManimStatus()
  if (!data || data.state === 'ready') return null
  return (
    <span className={data.state === 'error' ? 'text-danger' : 'text-warning'}>
      {data.state === 'installing'
        ? t('plugins.manimInstalling', { phase: t(`plugins.manimPhase_${data.phase ?? 'packages'}`) })
        : t('plugins.manimDownload')}
    </span>
  )
}

/** 插件“管理”里的运行环境：下载 / 进度 / 删除 */
export function ManimRuntime() {
  const { t } = useTranslation()
  const { data: s } = useManimStatus()
  const [useSystem, setUseSystem] = useState(true),
    [busy, setBusy] = useState(false)
  if (!s) return <div role="status" className="h-16 animate-pulse rounded-lg bg-sunken" />
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(pluginError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-2 rounded-xl border border-border p-4 text-sm" data-testid="manim-runtime">
      <h3 className="font-medium text-fg">{t('plugins.manimTitle')}</h3>
      {s.state === 'unsupported' && <p className="text-muted">{t('plugins.manimUnsupported')}</p>}
      {(s.state === 'missing' || s.state === 'error') && (
        <>
          {s.state === 'error' && (
            <p className="text-xs text-danger [overflow-wrap:anywhere]">{t('plugins.manimError', { error: s.error })}</p>
          )}
          <p className="text-muted">
            {t('plugins.manimMissing', {
              size: size(useSystem && s.systemTex ? s.estimate : s.estimate + (s.systemTex ? 35e6 : 0)),
              installed: size(useSystem && s.systemTex ? 760e6 : 930e6)
            })}
          </p>
          {s.systemTex && (
            <label className="flex items-start gap-2 text-xs text-muted">
              <input type="checkbox" className="mt-0.5" checked={useSystem} onChange={(e) => setUseSystem(e.target.checked)} />
              <span>
                {t('plugins.manimUseSystemTex')}
                <span className="block text-subtle">{t('plugins.manimSystemTex', { path: s.systemTex })}</span>
              </span>
            </label>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => api.manim.install({ useSystemTex: useSystem }))}
          >
            {s.state === 'error' ? t('plugins.manimRetry') : t('plugins.manimDownload')}
          </Button>
        </>
      )}
      {s.state === 'installing' && (
        <>
          <p className="text-muted">{t('plugins.manimInstalling', { phase: t(`plugins.manimPhase_${s.phase ?? 'packages'}`) })}</p>
          <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={Math.round(s.progress * 100)}>
            <div
              className={cn('h-full rounded-full bg-accent transition-[width] duration-300')}
              style={{ width: `${Math.max(3, s.progress * 100)}%` }}
            />
          </div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api.manim.cancel())}>
            {t('plugins.cancel')}
          </Button>
        </>
      )}
      {s.state === 'ready' && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted">
            {t('plugins.manimReady', {
              size: size(s.bytes),
              tex: t(s.tex === 'system' ? 'plugins.manimTexSystem' : 'plugins.manimTexTiny')
            })}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(async () => toast.success(t('plugins.manimRemoved', { size: size(await api.manim.remove()) })))}
          >
            {t('plugins.manimRemove')}
          </Button>
        </div>
      )}
    </section>
  )
}
