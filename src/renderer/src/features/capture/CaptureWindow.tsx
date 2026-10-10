import { useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { CaptureState } from '@shared/capture'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
export function CaptureWindow() {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<CaptureState | null>(null),
    [text, setText] = useState(''),
    [formulas, setFormulas] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const assetId = useRef<string | null>(null)
  const dirty = useRef(false),
    start = useRef<{ x: number; y: number } | null>(null),
    [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  // 主进程失焦时据此决定是否关闭：已写了内容或放了图片就保留小窗，避免切到别处复制时丢稿
  useEffect(() => {
    ;(window as Window & { __captureDirty?: boolean }).__captureDirty = !!text.trim() || !!state?.image
  }, [text, state?.image])
  useEffect(() => {
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void api.capture.close()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  useEffect(() => {
    const update = (s: CaptureState | null): void => {
      setState(s)
      if ((s?.asset?.id ?? null) !== assetId.current) {
        assetId.current = s?.asset?.id ?? null
        setFormulas([])
        if (!dirty.current) setText('')
      }
      if (s?.recognition) {
        if (!dirty.current)
          setText(
            s.recognition.blocks.length
              ? s.recognition.blocks
                  .filter((b) => b.label !== 'formula')
                  .map((b) => b.text)
                  .join('\n')
              : s.recognition.text
          )
        setFormulas(s.recognition.blocks.filter((b) => b.label === 'formula').map((b) => b.text))
      }
    }
    void api.capture.state().then(update)
    void api.settings.get().then((s) => {
      void i18n.changeLanguage(s.language)
      document.documentElement.dataset.theme =
        s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
    })
    return window.jiweiEvents.on('capture:changed', update)
  }, [i18n])
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message.match(/capture\.[a-zA-Z]+/)?.[0] ?? message)
    } finally {
      setBusy(false)
    }
  }
  const attach = async (file: File): Promise<void> => {
    if (!state) return
    if (file.size > 25 * 1024 * 1024) throw new Error('capture.tooLarge')
    await api.capture.attach(state.id, new Uint8Array(await file.arrayBuffer()), file.name, file.type)
  }
  const action = (action: 'save' | 'ask' | 'insert'): void => {
    if (state)
      void run(() =>
        api.capture.action({
          id: state.id,
          action,
          text: action === 'save' ? [text, ...formulas].filter(Boolean).join('\n') : text,
          formulas
        })
      )
  }
  return (
    <div
      data-testid="capture-window"
      className="flex h-full flex-col gap-3 overflow-y-auto bg-surface p-5 text-fg"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          action('save')
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const file = e.dataTransfer.files[0]
        if (file) void run(() => attach(file))
      }}
      onPaste={(e) => {
        const file = e.clipboardData.files[0]
        if (file) {
          e.preventDefault()
          void run(() => attach(file))
        }
      }}
    >
      <header className="drag flex items-center justify-between">
        <h1 className="font-serif text-xl">{t('capture.title')}</h1>
        <Button className="no-drag" onClick={() => void api.capture.close()}>
          {t('capture.close')}
        </Button>
      </header>
      {state?.origin.app && (
        <p className="truncate text-xs text-subtle">
          {state.origin.app} · {state.origin.windowTitle}
        </p>
      )}
      {state?.clipboard && (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const value = await api.capture.paste(state.id)
              if (value) {
                dirty.current = true
                setText((v) => (v ? `${v}\n${value}` : value))
              }
            })
          }
        >
          {t('capture.paste')}
        </Button>
      )}
      {state?.image && (
        <div
          className="relative shrink-0"
          onPointerDown={(e) => {
            if (state.mode !== 'select') return
            e.currentTarget.setPointerCapture(e.pointerId)
            const r = e.currentTarget.getBoundingClientRect()
            start.current = { x: e.clientX - r.x, y: e.clientY - r.y }
            setBox(null)
          }}
          onPointerMove={(e) => {
            if (!start.current) return
            const r = e.currentTarget.getBoundingClientRect(),
              x = Math.max(0, Math.min(r.width, e.clientX - r.x)),
              y = Math.max(0, Math.min(r.height, e.clientY - r.y))
            setBox({
              x: Math.min(start.current.x, x),
              y: Math.min(start.current.y, y),
              width: Math.abs(x - start.current.x),
              height: Math.abs(y - start.current.y)
            })
          }}
          onPointerUp={(e) => {
            start.current = null
            if (!box || state.mode !== 'select') return
            const img = e.currentTarget.querySelector('img')!,
              sx = img.naturalWidth / img.clientWidth,
              sy = img.naturalHeight / img.clientHeight
            if (box.width > 2 && box.height > 2)
              void run(() =>
                api.capture.crop(state.id, {
                  x: Math.floor(box.x * sx),
                  y: Math.floor(box.y * sy),
                  width: Math.floor(box.width * sx),
                  height: Math.floor(box.height * sy)
                })
              )
            setBox(null)
          }}
        >
          <img
            src={state.image}
            alt={t('capture.image')}
            draggable={false}
            className={state.mode === 'select' ? 'w-full cursor-crosshair select-none' : 'max-h-52 max-w-full rounded-lg object-contain'}
          />
          {box && (
            <div
              className="pointer-events-none absolute border-2 border-accent bg-accent/10"
              style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
            />
          )}
        </div>
      )}
      {state?.mode === 'select' && <p>{t('capture.select')}</p>}
      {state?.asset && !state.image && <p>{t('capture.attached')}</p>}
      {state?.recognitionState === 'pending' && <p role="status">{t('capture.recognizing')}</p>}
      {state?.recognitionState === 'unavailable' && (
        <p role="status" className="text-sm text-subtle">
          {t('capture.unavailable')}
        </p>
      )}
      <textarea
        autoFocus
        aria-label={t('capture.text')}
        placeholder={t('capture.hint')}
        rows={5}
        className="min-h-28 w-full shrink-0 resize-y rounded-xl border border-border bg-canvas p-3 text-sm"
        value={text}
        onChange={(e) => {
          dirty.current = true
          setText(e.target.value)
        }}
      />
      {formulas.map((formula, i) => (
        <div key={i} className="flex gap-2">
          <textarea
            aria-label="LaTeX"
            className="min-w-0 flex-1 rounded border border-border p-2"
            value={formula}
            onChange={(e) => setFormulas((v) => v.map((s, j) => (j === i ? e.target.value : s)))}
          />
          <Button onClick={() => void navigator.clipboard.writeText(formula)}>{t('capture.copyLatex')}</Button>
        </div>
      ))}
      {(error || state?.error) && (
        <p role="alert" className="text-sm text-danger">
          {t(error || state!.error!)}
        </p>
      )}
      <footer className="mt-auto flex flex-wrap gap-2">
        <Button disabled={busy || state?.mode === 'select' || (!text.trim() && !state?.asset)} onClick={() => action('save')}>
          {t('capture.save')}
        </Button>
        {state?.image && (
          <>
            <Button disabled={busy} onClick={() => action('ask')}>
              {t('capture.ask')}
            </Button>
            <Button disabled={busy || !state.targetNoteId} onClick={() => action('insert')}>
              {t('capture.insert')}
            </Button>
          </>
        )}
      </footer>
    </div>
  )
}
