import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { PluginDetection, PluginInfo, PluginInspectInput, PluginPreview } from '@shared/plugins'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PlanDialog, field } from '../plan/ui'
import { PluginConfirmDialog, pluginError } from './PluginConfirmDialog'
import { PluginDetailsDialog } from './PluginDetailsDialog'

type Request = { file: true } | { update: string } | { source: PluginInspectInput; details?: boolean }
/** 下载前先取得 main 所有的 operation；关闭和卸载组件都撤销它，包括尚未返回 token 的请求。 */
export function usePluginAcquisition() {
  const { t } = useTranslation()
  const operation = useRef<string | null>(null),
    generation = useRef(0)
  const [active, setActive] = useState(false),
    [busy, setBusy] = useState(false)
  const [detection, setDetection] = useState<PluginDetection | null>(null),
    [error, setError] = useState('')
  const [current, setCurrent] = useState<PluginInfo>(),
    [details, setDetails] = useState(false)
  const [selected, setSelected] = useState<string[]>([]),
    [progress, setProgress] = useState({ phase: 'download', received: 0, total: 0 })
  const request = useRef<Request | null>(null)
  useEffect(() => {
    const lifecycle = generation
    const off = window.jiweiEvents.on('plugins:progress', (e) => {
      if (e.id === operation.current) setProgress({ phase: e.phase, received: e.received ?? 0, total: e.total ?? 0 })
    })
    return () => {
      off()
      lifecycle.current++
      if (operation.current) void api.plugins.cancelAcquisition(operation.current)
    }
  }, [])
  const close = async () => {
    generation.current++
    const id = operation.current
    operation.current = null
    setActive(false)
    setDetection(null)
    setBusy(false)
    if (id) await api.plugins.cancelAcquisition(id)
  }
  const start = async (input: Request) => {
    await close()
    const run = ++generation.current
    request.current = input
    setActive(true)
    setBusy(true)
    setError('')
    setCurrent(undefined)
    setDetails('source' in input && !!input.details)
    setProgress({ phase: 'download', received: 0, total: 0 })
    let id: string | undefined
    try {
      id = await api.plugins.beginAcquisition()
      if (run !== generation.current) {
        await api.plugins.cancelAcquisition(id)
        return
      }
      operation.current = id
      const result: PluginDetection | null =
        'file' in input
          ? await api.plugins.acquireFile(id)
          : 'update' in input
            ? { kind: 'plugin', preview: await api.plugins.acquireUpdate(id, input.update) }
            : await api.plugins.acquire(id, input.source)
      if (run !== generation.current) return
      if (!result) {
        await close()
        return
      }
      if (result.kind === 'plugin') setCurrent((await api.plugins.list()).find((p) => p.id === result.preview.id))
      if (run !== generation.current) return
      if (result.kind === 'skills') setSelected(result.skills.map((s) => s.path))
      setDetection(result)
    } catch (e) {
      if (id) await api.plugins.cancelAcquisition(id)
      if (run === generation.current) {
        operation.current = null
        setError(pluginError(e))
      }
    } finally {
      if (run === generation.current) setBusy(false)
    }
  }
  const choose = async () => {
    if (!operation.current || !detection || detection.kind === 'plugin') return
    const run = generation.current
    setBusy(true)
    setError('')
    try {
      if (detection.kind === 'market') {
        await api.plugins.addDetectedMarket(operation.current, detection.token)
        await close()
        toast.success(t('plugins.marketAdded'))
      } else {
        const result = await api.plugins.selectSkills(operation.current, detection.token, selected)
        if (run === generation.current) {
          if (result.kind === 'plugin') setCurrent((await api.plugins.list()).find((p) => p.id === result.preview.id))
          setDetection(result)
        }
      }
    } catch (e) {
      if (run === generation.current) setError(pluginError(e))
    } finally {
      if (run === generation.current) setBusy(false)
    }
  }
  const preview: PluginPreview | undefined = detection?.kind === 'plugin' ? detection.preview : undefined
  const dialog = !active ? null : preview ? (
    details ? (
      <PluginDetailsDialog preview={preview} onClose={() => void close()} onInstall={() => setDetails(false)} />
    ) : (
      <PluginConfirmDialog
        key={preview.token}
        preview={preview}
        current={current}
        onClose={() => void close()}
        onInstalled={() => {
          void close()
          toast.success(t('plugins.done'))
        }}
      />
    )
  ) : (
    <PlanDialog
      title={t(
        detection?.kind === 'market'
          ? 'plugins.marketDetected'
          : detection?.kind === 'skills'
            ? 'plugins.selectSkills'
            : 'plugins.acquiring'
      )}
      testId="plugin-acquisition"
      onClose={() => void close()}
      footer={
        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={() => void close()}>{t('plugins.cancel')}</Button>
          {error && !detection && (
            <Button disabled={busy} onClick={() => request.current && void start(request.current)}>
              {t('plugins.retry')}
            </Button>
          )}
          {detection && (
            <Button variant="primary" disabled={busy || (detection.kind === 'skills' && !selected.length)} onClick={() => void choose()}>
              {t(detection.kind === 'market' ? 'plugins.trustAccept' : 'plugins.continue')}
            </Button>
          )}
        </div>
      }
    >
      {busy && (
        <div role="status" className="space-y-2 text-sm">
          <p>{t(`plugins.${progress.phase === 'install' ? 'installing' : progress.phase}`)}</p>
          <p>{t('plugins.received', { size: `${(progress.received / 1024).toFixed(1)} KB` })}</p>
          {progress.total > 0 && <progress className="w-full" value={progress.received} max={progress.total} />}
        </div>
      )}
      {detection?.kind === 'market' && (
        <div className="space-y-3 text-sm [overflow-wrap:anywhere]">
          <p>
            {detection.name} · {detection.count}
          </p>
          <p className="text-warning">{t('plugins.trust', { owner: detection.owner })}</p>
        </div>
      )}
      {detection?.kind === 'skills' &&
        detection.skills.map((s) => (
          <label key={s.path} className="flex gap-2 text-sm [overflow-wrap:anywhere]">
            <input
              type="checkbox"
              checked={selected.includes(s.path)}
              disabled={busy}
              onChange={(e) => setSelected(e.target.checked ? [...selected, s.path] : selected.filter((p) => p !== s.path))}
            />
            <span>
              {s.name}
              <small className="block text-muted">{s.path}</small>
            </span>
          </label>
        ))}
      {error && (
        <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      {!detection && (
        <p className="text-xs text-muted">
          {t('plugins.githubError')} {t('plugins.sourceHelp')}
        </p>
      )}
    </PlanDialog>
  )
  return { start, active, dialog }
}
export function PluginInstallButtons({ fileOnly = false }: { fileOnly?: boolean }) {
  const { t } = useTranslation()
  const acquisition = usePluginAcquisition()
  const [github, setGithub] = useState(false),
    [url, setUrl] = useState('')
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button disabled={acquisition.active} onClick={() => void acquisition.start({ file: true })}>
          {t('plugins.fromFile')}
        </Button>
        {!fileOnly && (
          <Button disabled={acquisition.active} onClick={() => setGithub(true)}>
            {t('plugins.fromGithub')}
          </Button>
        )}
      </div>
      {github && (
        <PlanDialog
          title={t('plugins.fromGithub')}
          onClose={() => setGithub(false)}
          testId="plugin-github"
          footer={
            <Button
              className="ml-auto"
              disabled={!url.trim()}
              onClick={() => {
                setGithub(false)
                void acquisition.start({ source: { kind: 'github', url: url.trim() } })
              }}
            >
              {t('plugins.continue')}
            </Button>
          }
        >
          <label className="block text-sm">
            {t('plugins.github')}
            <input
              autoFocus
              className={field}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url.trim()) {
                  setGithub(false)
                  void acquisition.start({ source: { kind: 'github', url: url.trim() } })
                }
              }}
            />
          </label>
          <p className="text-xs text-muted">{t('plugins.sourceHelp')}</p>
        </PlanDialog>
      )}
      {acquisition.dialog}
    </>
  )
}
