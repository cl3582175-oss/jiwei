import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { BrowserCaptureFrame, BrowserCaptureResult, CaptureRect } from '@shared/browserCapture'
import type { BrowserTab } from '@shared/types'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { askInline, saveToNote } from '../assist/actions'
import { Button } from '@/components/ui/button'
import { ArrowDown, ArrowUp, Layers, ScanText, Trash2, X } from 'lucide-react'

interface Entry {
  result: BrowserCaptureResult
  text: string
}
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
export function useBrowserCapture(tab: BrowserTab | null, slot: React.RefObject<HTMLDivElement | null>) {
  const { t } = useTranslation()
  const [frame, setFrame] = useState<BrowserCaptureFrame | null>(null)
  const [card, setCard] = useState<Entry | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [continuous, setContinuous] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const owned = useRef(new Set<string>())
  const revision = useRef(0)
  const release = (id: string): void => {
    owned.current.delete(id)
    void api.browser.captureRelease(id)
  }
  useEffect(
    () => () => {
      revision.current++
      for (const id of owned.current) void api.browser.captureRelease(id)
      owned.current.clear()
    },
    []
  )
  useEffect(() => {
    const captured = frame ?? card?.result
    if (captured && (!tab || tab.id !== captured.tabId || tab.scope !== captured.scope || tab.sensitive || tab.incognito)) {
      revision.current++
      if (!entries.some((e) => e.result.id === captured.id)) release(captured.id)
      setFrame(null)
      setCard(null)
      setSelecting(false)
      setBusy(false)
    }
  }, [tab, frame, card, entries])
  const close = (): void => {
    if (saving) return
    revision.current++
    const id = frame?.id ?? card?.result.id
    if (id && !entries.some((e) => e.result.id === id)) release(id)
    setFrame(null)
    setCard(null)
    setSelecting(false)
    setBusy(false)
  }
  const start = async (): Promise<void> => {
    if (saving) return
    // 关闭卡片会改变网页可见面积；先提交布局并同步原生 bounds，再冻结新帧。
    flushSync(() => {
      close()
      setSelecting(true)
      setBusy(true)
    })
    const rev = ++revision.current
    try {
      const bounds = slot.current?.getBoundingClientRect()
      if (!bounds) throw new Error(t('browserCapture.unavailable'))
      await api.browser.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (revision.current !== rev) return
      const next = await api.browser.captureBegin()
      owned.current.add(next.id)
      if (revision.current !== rev) {
        release(next.id)
        return
      }
      setFrame(next)
    } catch (e) {
      toast.error(errorText(e))
      setSelecting(false)
    } finally {
      if (rev === revision.current) setBusy(false)
    }
  }
  const recognize = async (rect: CaptureRect): Promise<void> => {
    if (!frame || busy) return
    const rev = revision.current
    setBusy(true)
    try {
      const result = await api.browser.captureRecognize(frame.id, rect)
      if (rev !== revision.current) return
      const entry = { result, text: result.recognition?.text ?? '' }
      if (continuous) {
        await api.browser.capturePrepare(result.id, true)
        if (rev !== revision.current) return
        setEntries((list) => [...list, entry])
      }
      setCard(entry)
      setFrame(null)
      setSelecting(false)
    } catch (e) {
      toast.error(errorText(e))
      close()
    } finally {
      if (rev === revision.current) setBusy(false)
    }
  }
  const edit = (text: string): void => {
    if (!card) return
    setCard({ ...card, text })
    setEntries((list) => list.map((e) => (e.result.id === card.result.id ? { ...e, text } : e)))
  }
  const add = async (): Promise<void> => {
    if (!card) return
    try {
      await api.browser.capturePrepare(card.result.id, true)
      setEntries((list) => (list.some((e) => e.result.id === card.result.id) ? list : [...list, card]))
      setContinuous(true)
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const save = async (list: Entry[]): Promise<void> => {
    if (!list.length || list.some((e) => !e.text.trim()) || saving) return
    setSaving(true)
    try {
      const ok = await saveToNote({
        cue: '',
        answer: '',
        anchor: list[0].result.anchor,
        model: null,
        browserEntries: list.map((e) => ({ id: e.result.id, text: e.text }))
      })
      if (ok) {
        const ids = new Set(list.map((e) => e.result.id))
        setEntries((old) => old.filter((e) => !ids.has(e.result.id)))
        ids.forEach(release)
        if (card && ids.has(card.result.id)) setCard(null)
      }
    } finally {
      setSaving(false)
    }
  }
  const ask = async (action: 'ask' | 'explain', rect: DOMRect): Promise<void> => {
    if (!card) return
    try {
      const result = await api.browser.capturePrepare(card.result.id, false, true)
      await askInline(
        action,
        { ...result.anchor, quote: card.text.slice(0, 8000) },
        { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        undefined,
        result.image,
        [],
        () => api.browser.capturePrepare(result.id, false, true)
      )
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const cardView = card && (
    <aside
      data-testid="browser-recognition-card"
      className="flex h-[42%] min-h-0 w-full shrink-0 flex-col gap-2.5 overflow-y-auto border-t border-border bg-surface p-3 @min-[640px]:h-auto @min-[640px]:w-[44%] @min-[640px]:max-w-[320px] @min-[640px]:border-t-0 @min-[640px]:border-l"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
          <ScanText className="size-3.5 text-accent" />
          {t('browserCapture.title')}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label={t('common.close')} disabled={saving} onClick={close}>
          <X />
        </Button>
      </div>
      <img
        src={card.result.image}
        alt={t('browserCapture.region')}
        className="max-h-24 w-full rounded-md border border-border bg-sunken object-contain"
      />
      {!card.result.recognition && (
        <button
          className="rounded-md bg-accent-soft px-2.5 py-1.5 text-left text-xs leading-relaxed text-accent hover:underline"
          onClick={() => useApp.getState().openSettings('ai')}
        >
          {t('browserCapture.noModel')}
        </button>
      )}
      <textarea
        aria-label={t('browserCapture.text')}
        disabled={saving}
        value={card.text}
        onChange={(e) => edit(e.target.value)}
        className="min-h-24 w-full flex-1 resize-y rounded-md border border-border bg-surface p-2.5 text-xs leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
      />
      <div className="flex flex-wrap gap-1">
        <Button size="sm" onClick={(e) => void ask('explain', e.currentTarget.getBoundingClientRect())}>
          {t('browserCapture.explain')}
        </Button>
        <Button size="sm" onClick={(e) => void ask('ask', e.currentTarget.getBoundingClientRect())}>
          {t('browserCapture.ask')}
        </Button>
        <Button size="sm" variant="primary" disabled={!card.text.trim() || saving} onClick={() => void save([card])}>
          {t('browserCapture.save')}
        </Button>
        <Button size="sm" disabled={saving} onClick={() => {
          setSaving(true)
          void api.mistakes.fromBrowserCapture(card.result.id).then(() => {
            const state = useApp.getState()
            state.setReviewTab('mistakes')
            state.setView('review')
            close()
          }).catch((e) => toast.error(errorText(e))).finally(() => setSaving(false))
        }}>{t('mistakes.saveAs')}</Button>
        <Button size="sm" onClick={() => void navigator.clipboard.writeText(card.text).catch((e) => toast.error(errorText(e)))}>
          {t('browserCapture.copy')}
        </Button>
        <Button size="sm" onClick={() => void add()} disabled={saving || entries.some((e) => e.result.id === card.result.id)}>
          {t('browserCapture.add')}
        </Button>
      </div>
    </aside>
  )
  const panel = continuous && (
    <section
      data-testid="browser-excerpts"
      className="flex max-h-[35%] min-h-24 shrink-0 flex-col border-t border-border bg-surface px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto flex items-center gap-1.5 font-medium text-fg">
          <Layers className="size-3.5 text-accent" />
          {t('browserCapture.excerpts', { count: entries.length })}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={saving || !entries.length || entries.some((e) => !e.text.trim())}
          onClick={() => void save(entries)}
        >
          {t('browserCapture.saveAll')}
        </Button>
        <Button size="sm" variant="ghost" disabled={entries.length > 0} onClick={() => setContinuous(false)}>
          {t('common.close')}
        </Button>
      </div>
      <ol className="mt-2 min-h-0 space-y-2 overflow-auto">
        {entries.map((entry, i) => (
          <li key={entry.result.id} className="group rounded-lg border border-border bg-sunken/50 p-2" data-testid="browser-excerpt">
            <textarea
              aria-label={t('browserCapture.excerptText', { number: i + 1 })}
              disabled={saving}
              value={entry.text}
              onChange={(e) => {
                const text = e.target.value
                setEntries((old) => old.map((x) => (x.result.id === entry.result.id ? { ...x, text } : x)))
                if (card?.result.id === entry.result.id) setCard({ ...card, text })
              }}
              className="min-h-12 w-full resize-y rounded bg-transparent p-1 leading-relaxed outline-none focus:bg-surface"
            />
            <div className="mt-1 flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-2xs text-subtle" title={`${entry.result.title} · ${entry.result.url}`}>
                <span className="font-medium tabular-nums text-muted">{i + 1}</span> · {entry.result.title} ·{' '}
                {new Date(entry.result.capturedAt).toLocaleTimeString()}
              </span>
              {[-1, 1].map((d) => (
                <Button
                  key={d}
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t(d < 0 ? 'browserCapture.up' : 'browserCapture.down')}
                  title={t(d < 0 ? 'browserCapture.up' : 'browserCapture.down')}
                  disabled={saving || i + d < 0 || i + d >= entries.length}
                  onClick={() =>
                    setEntries((old) => {
                      const next = [...old]
                      ;[next[i], next[i + d]] = [next[i + d], next[i]]
                      return next
                    })
                  }
                >
                  {d < 0 ? <ArrowUp /> : <ArrowDown />}
                </Button>
              ))}
              <Button
                size="icon-sm"
                variant="ghost"
                className="hover:text-danger"
                aria-label={t('browserCapture.remove')}
                title={t('browserCapture.remove')}
                disabled={saving}
                onClick={() => {
                  setEntries((old) => old.filter((x) => x.result.id !== entry.result.id))
                  if (card?.result.id === entry.result.id) setCard(null)
                  release(entry.result.id)
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
  return { selecting, frame, busy, start, close, recognize, cardView, panel }
}

export function CaptureSelection({
  frame,
  busy,
  onSelect,
  onCancel
}: {
  frame: BrowserCaptureFrame | null
  busy: boolean
  onSelect: (rect: CaptureRect) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [rect, setRect] = useState<CaptureRect | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      data-testid="browser-capture-selection"
      className="absolute inset-0 touch-none select-none bg-sunken"
      onPointerDown={(e) => {
        if (!frame || busy || (e.target as HTMLElement).closest('button')) return
        const b = e.currentTarget.getBoundingClientRect()
        start.current = { x: (e.clientX - b.x) / b.width, y: (e.clientY - b.y) / b.height }
        setRect(null)
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const b = e.currentTarget.getBoundingClientRect()
        const x = Math.max(0, Math.min(1, (e.clientX - b.x) / b.width)),
          y = Math.max(0, Math.min(1, (e.clientY - b.y) / b.height))
        setRect({
          x: Math.min(x, start.current.x),
          y: Math.min(y, start.current.y),
          w: Math.abs(x - start.current.x),
          h: Math.abs(y - start.current.y)
        })
      }}
      onPointerUp={() => {
        start.current = null
        if (rect && rect.w > 0.01 && rect.h > 0.01) void onSelect(rect)
      }}
    >
      {frame && <img src={frame.image} alt="" draggable={false} className="pointer-events-none size-full object-fill" />}
      {rect && (
        <div
          className="pointer-events-none absolute border-2 border-accent bg-accent/10"
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
        />
      )}
      <div className="absolute right-1 bottom-1 left-1 flex flex-wrap items-center justify-between gap-1 rounded bg-surface/95 p-2 text-xs">
        <span>{t(busy ? 'browserCapture.busy' : 'browserCapture.select')}</span>
        <button onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}
