import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, FileDown, Loader2, Pause, Play, RotateCcw, Sparkles, Trash2, Video } from 'lucide-react'
import { LOCAL_VOICES, TTS_VOICES } from '@shared/discover'
import { sceneCaptions, type SceneData, type VideoScene, type VideoVoice, type Work, type WorkParts } from '@shared/works'
import { Button } from '@/components/ui/button'
import { api, cn } from '@/lib/utils'
import { Segmented, field } from '@/features/plan/ui'
import { SceneView, STAGE_H, STAGE_W, locate, type SceneTiming } from '@/scene/SceneView'

// 讲解视频的三步（v0.9）：分镜（结构）→ 配音与预览（起草）→ 渲染与导出（成品）。

const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 预览用的估算时长：中文约 4.2 字 / 秒 */
export function estimateTimings(scenes: VideoScene[], zh: boolean): SceneTiming[] {
  let start = 0
  return scenes.map((s) => {
    const spoken = Math.max(1.5, zh ? s.narration.replace(/\s/g, '').length / 4.2 : s.narration.split(/\s+/).length / 2.6)
    const duration = Math.max(s.template === 'title' ? 3.5 : 3, 0.35 + spoken + 0.6)
    const t = { start, duration, captions: sceneCaptions(s.narration, 0.35, spoken) }
    start += duration
    return t
  })
}

/** 等比缩放的 16:9 舞台 */
function Stage({ width, children }: { width: number; children: React.ReactNode }) {
  const scale = width / STAGE_W
  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-[#FBFCFA] shadow-[var(--shadow-1)]"
      style={{ width, height: STAGE_H * scale }}
    >
      <div style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{children}</div>
    </div>
  )
}

function useContent(w: Work): [Extract<WorkParts, { kind: 'video' }> | null, (next: Extract<WorkParts, { kind: 'video' }>) => void] {
  const [content, setContent] = useState(w.content?.kind === 'video' ? w.content : null)
  const timer = useRef(0)
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setContent(w.content?.kind === 'video' ? w.content : null)
  }, [w.content])
  const update = (next: Extract<WorkParts, { kind: 'video' }>): void => {
    setContent(next)
    editing.current = true
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void api.works.update({ id: w.id, content: next }).finally(() => (editing.current = false))
    }, 600)
  }
  return [content, update]
}

const lines = (s: string): string[] => s.split('\n')

/* ——— 分镜 ——— */

export function StoryboardStep({ w, next }: { w: Work; next: () => void }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [content, update] = useContent(w)
  const zh = i18n.language.startsWith('zh')
  const generate = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.works.outline(w.id)
      void qc.invalidateQueries({ queryKey: ['works'] })
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const scenes = useMemo(() => content?.parts ?? [], [content])
  const timings = useMemo(() => estimateTimings(scenes, zh), [scenes, zh])
  const set = (i: number, s: VideoScene): void => update({ ...content!, parts: scenes.map((x, k) => (k === i ? s : x)) })
  const move = (i: number, d: -1 | 1): void => {
    const out = [...scenes]
    ;[out[i], out[i + d]] = [out[i + d], out[i]]
    update({ ...content!, parts: out })
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant={content ? 'outline' : 'primary'} size="sm" disabled={busy} onClick={() => void generate()}>
          {content ? <RotateCcw /> : <Sparkles />}
          {content ? t('works.video.regenerate') : t('works.video.storyboard')}
        </Button>
        {content && (
          <span className="ml-auto text-2xs text-subtle tabular-nums">
            {t('works.video.length', { sec: Math.round(timings.reduce((n, x) => n + x.duration, 0)), count: scenes.length })}
          </span>
        )}
      </div>
      <p className="text-2xs text-subtle">{t('works.video.storyboardHint')}</p>
      {busy && (
        <p role="status" className="flex items-center gap-2 text-xs text-accent">
          <Loader2 className="size-3.5 animate-spin" />
          {t('works.video.storyboarding')}
        </p>
      )}
      <ol className="space-y-3" data-testid="storyboard">
        {scenes.map((s, i) => (
          <li
            key={s.id}
            className="group flex gap-4 rounded-2xl border border-border bg-surface p-3 shadow-[var(--shadow-1)]"
            data-scene={i}
          >
            <div className="shrink-0">
              <Stage width={224}>
                <SceneView scene={s} t={timings[i]?.duration ?? 3} duration={timings[i]?.duration ?? 3} />
              </Stage>
              <p className="mt-1.5 text-center text-2xs text-subtle">
                {i + 1} · {t(`works.video.templates.${s.template}`)}
              </p>
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <input
                aria-label={t('works.partTitle')}
                className="w-full bg-transparent text-sm font-semibold text-fg outline-none"
                value={s.title}
                placeholder={t('works.partTitle')}
                onChange={(e) => set(i, { ...s, title: e.target.value })}
              />
              <SceneFields s={s} onChange={(x) => set(i, x)} />
              <label className="block text-2xs text-muted">
                {t('works.video.narration')}
                <textarea
                  aria-label={t('works.video.narration')}
                  className="mt-1 block w-full resize-none rounded-lg bg-sunken/60 px-2.5 py-2 text-sm leading-relaxed text-fg outline-none"
                  rows={2}
                  value={s.narration}
                  onChange={(e) => set(i, { ...s, narration: e.target.value })}
                />
              </label>
            </div>
            <div className="flex shrink-0 flex-col opacity-40 transition-opacity group-hover:opacity-100">
              <Button size="icon-sm" variant="ghost" aria-label={t('works.moveUp')} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('works.moveDown')}
                disabled={i === scenes.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('works.deletePart')}
                onClick={() => update({ ...content!, parts: scenes.filter((x) => x.id !== s.id) })}
              >
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex border-t border-border/70 pt-4">
        <Button className="ml-auto" variant="outline" disabled={!scenes.length} onClick={next}>
          {t('works.next')}
        </Button>
      </div>
    </div>
  )
}

/** 各模板的参数编辑（简洁的文本形式，复杂数据保持 AI 生成的结构） */
function SceneFields({ s, onChange }: { s: VideoScene; onChange: (s: VideoScene) => void }) {
  const { t } = useTranslation()
  const area = (label: string, value: string, set: (v: string) => void, mono = false) => (
    <label className="block text-2xs text-muted">
      {label}
      <textarea
        aria-label={label}
        className={cn('mt-1 block w-full resize-none bg-transparent text-xs leading-relaxed text-fg outline-none', mono && 'font-mono')}
        rows={Math.min(6, Math.max(2, value.split('\n').length))}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  )
  switch (s.template) {
    case 'title':
      return (
        <input
          aria-label={t('works.video.subtitle')}
          className="w-full bg-transparent text-xs text-muted outline-none"
          placeholder={t('works.video.subtitle')}
          value={s.subtitle}
          onChange={(e) => onChange({ ...s, subtitle: e.target.value })}
        />
      )
    case 'bullets':
    case 'summary':
      return area(t('works.video.items'), s.items.join('\n'), (v) => onChange({ ...s, items: lines(v) }))
    case 'formula':
      return area(t('works.video.steps'), s.steps.join('\n'), (v) => onChange({ ...s, steps: lines(v) }), true)
    case 'diagram':
      return area(t('works.video.code'), s.code, (v) => onChange({ ...s, code: v }), true)
    case 'graph':
      return area(t('works.video.functions'), s.functions.join('\n'), (v) => onChange({ ...s, functions: lines(v) }), true)
    case 'quote':
      return (
        <>
          {area(t('works.video.quote'), s.quote, (v) => onChange({ ...s, quote: v }))}
          <input
            aria-label={t('works.video.by')}
            className="w-full bg-transparent text-xs text-muted outline-none"
            placeholder={t('works.video.by')}
            value={s.by}
            onChange={(e) => onChange({ ...s, by: e.target.value })}
          />
        </>
      )
    case 'compare':
      return (
        <div className="grid grid-cols-2 gap-3">
          {(['left', 'right'] as const).map((side) => (
            <div key={side}>
              <input
                className="w-full bg-transparent text-xs font-medium text-fg outline-none"
                aria-label={side}
                value={s[side].title}
                onChange={(e) => onChange({ ...s, [side]: { ...s[side], title: e.target.value } })}
              />
              {area(t('works.video.items'), s[side].items.join('\n'), (v) => onChange({ ...s, [side]: { ...s[side], items: lines(v) } }))}
            </div>
          ))}
        </div>
      )
    case 'chart':
      return <p className="text-2xs text-subtle">{s.categories.join(' · ')}</p>
  }
}

/* ——— 配音与预览 ——— */

export function VideoStep({ w }: { w: Work }) {
  const { t, i18n } = useTranslation()
  const [content, update] = useContent(w)
  const { data: providers = [] } = useQuery({ queryKey: ['discover', 'tts'], queryFn: () => api.discover.ttsProviders() })
  const { data: speech } = useQuery({ queryKey: ['discover', 'speech'], queryFn: () => api.discover.speechStatus() })
  const zh = i18n.language.startsWith('zh')
  const scenes = useMemo(() => content?.parts ?? [], [content])
  const timings = useMemo(() => estimateTimings(scenes, zh), [scenes, zh])
  const total = timings.reduce((n, x) => n + x.duration, 0)
  const [T, setT] = useState(0),
    [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    let raf = 0,
      last = performance.now()
    const tick = (now: number): void => {
      setT((x) => {
        const n = x + (now - last) / 1000
        if (n >= total) {
          setPlaying(false)
          return total
        }
        return n
      })
      last = now
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, total])
  if (!content) return null
  const voice = content.voice
  const setVoice = (v: Partial<VideoVoice>): void => update({ ...content, voice: { ...voice, ...v } })
  const provider = providers.find((p) => p.providerId === voice.providerId) ?? providers[0]
  const voices = voice.engine === 'local' ? LOCAL_VOICES : voice.engine === 'ai' && provider ? TTS_VOICES[provider.engine] : []
  const at = locate(timings, Math.min(T, Math.max(0, total - 0.001)))
  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-fg">{t('works.video.voice')}</h3>
        <Segmented
          label={t('works.video.voice')}
          value={voice.engine}
          onChange={(engine) => setVoice({ engine, voice: null, providerId: engine === 'ai' ? (provider?.providerId ?? null) : null })}
          options={[
            { value: 'local', label: t('works.video.voiceLocal') },
            ...(providers.length ? [{ value: 'ai' as const, label: t('works.video.voiceAi') }] : []),
            { value: 'none', label: t('works.video.voiceNone') }
          ]}
        />
        {voice.engine === 'local' && speech?.state !== 'ready' && (
          <p className="text-xs text-warning">{t('works.video.voiceLocalMissing')}</p>
        )}
        {voices.length > 0 && (
          <select
            aria-label={t('works.video.voice')}
            className={cn(field, 'max-w-xs')}
            value={voice.voice ?? voices[0].id}
            onChange={(e) => setVoice({ voice: e.target.value })}
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {zh ? v.zh : v.en}
              </option>
            ))}
          </select>
        )}
      </section>
      <section data-testid="video-preview">
        <h3 className="text-sm font-semibold text-fg">{t('works.video.preview')}</h3>
        <div className="mt-3">
          <Stage width={640}>
            {scenes[at.index] && <SceneView scene={scenes[at.index]} t={at.t} duration={timings[at.index].duration} caption={at.caption} />}
          </Stage>
        </div>
        <div className="mt-3 flex max-w-[640px] items-center gap-3">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={playing ? t('works.video.pause') : t('works.video.play')}
            onClick={() => (T >= total ? (setT(0), setPlaying(true)) : setPlaying(!playing))}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <input
            type="range"
            aria-label={t('works.video.preview')}
            className="graph-range min-w-0 flex-1"
            min={0}
            max={total}
            step={0.05}
            value={T}
            onChange={(e) => {
              setPlaying(false)
              setT(Number(e.target.value))
            }}
          />
          <span className="w-20 shrink-0 text-right text-2xs text-subtle tabular-nums">
            {T.toFixed(1)} / {total.toFixed(0)}s
          </span>
        </div>
        <div className="mt-2 flex max-w-[640px] gap-1">
          {timings.map((x, i) => (
            <button
              key={i}
              className={cn('h-1.5 rounded-full transition-colors', i === at.index ? 'bg-accent' : 'bg-sunken hover:bg-border')}
              style={{ flex: x.duration }}
              aria-label={`${i + 1}`}
              onClick={() => {
                setPlaying(false)
                setT(x.start)
              }}
            />
          ))}
        </div>
        <p className="mt-2 text-2xs text-subtle">{t('works.video.previewHint')}</p>
      </section>
    </div>
  )
}

/* ——— 渲染与导出 ——— */

export function VideoDone({ w }: { w: Work }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: st, refetch } = useQuery({ queryKey: ['works', 'render', w.id], queryFn: () => api.works.renderStatus(w.id) })
  useEffect(() => window.jiweiEvents.on('works:changed', () => void refetch()), [refetch])
  const [nonce, setNonce] = useState(0)
  const running = st?.status === 'running'
  const render = async (): Promise<void> => {
    try {
      void api.works.render(w.id).then(
        () => {
          setNonce((n) => n + 1)
          void qc.invalidateQueries({ queryKey: ['works'] })
        },
        (e) => {
          if (!/Canceled/.test(String(e))) toast.error(t('works.video.failed', { message: errText(e) }))
        }
      )
      await new Promise((r) => setTimeout(r, 200))
      void refetch()
    } catch (e) {
      toast.error(errText(e))
    }
  }
  const save = async (format: 'mp4' | 'srt' | 'json'): Promise<void> => {
    try {
      const path = await api.works.exportVideo(w.id, format)
      if (path)
        toast.success(t('works.exported', { path: path.split(/[\\/]/).pop() }), {
          action: { label: t('works.reveal'), onClick: () => void api.app.showInFolder(path) }
        })
    } catch (e) {
      toast.error(errText(e))
    }
  }
  return (
    <section className="space-y-4" data-testid="video-done">
      <p className="text-xs text-muted">{t('works.video.renderHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={st?.status === 'done' ? 'outline' : 'primary'}
          size="sm"
          disabled={running || w.content?.kind !== 'video'}
          onClick={() => void render()}
        >
          {running ? <Loader2 className="animate-spin" /> : <Video />}
          {st?.status === 'done' ? t('works.video.rerender') : t('works.video.render')}
        </Button>
        {running && (
          <>
            <div className="h-1.5 w-56 overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${(st?.progress ?? 0) * 100}%` }}
              />
            </div>
            <span className="text-2xs text-muted tabular-nums">
              {st?.stage ? t(`works.video.stages.${st.stage}`) : t('works.video.rendering')} {Math.round((st?.progress ?? 0) * 100)}%
            </span>
            <Button size="sm" variant="ghost" onClick={() => void api.works.cancelRender(w.id)}>
              {t('works.video.cancel')}
            </Button>
          </>
        )}
      </div>
      {st?.status === 'error' && st.message && <p className="text-xs text-danger">{t('works.video.failed', { message: st.message })}</p>}
      {st?.status === 'done' && (
        <>
          <video
            key={nonce}
            className="w-full max-w-[720px] rounded-xl border border-border bg-black"
            controls
            src={`jiwei://works/${w.id}/video.mp4?v=${nonce}`}
            data-testid="video-player"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => void save('mp4')}>
              <FileDown />
              {t('works.video.exportMp4')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void save('srt')}>
              {t('works.video.exportSrt')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void save('json')}>
              {t('works.video.exportJson')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

export type { SceneData }
