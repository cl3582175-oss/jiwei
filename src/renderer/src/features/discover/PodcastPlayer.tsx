import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Headphones, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/utils'
import { useSettings } from '@/lib/queries'
import { Button } from '@/components/ui/button'

export function PodcastBar() {
  const { data: settings } = useSettings()
  return settings?.discover.podcast ? <PodcastPlayer /> : null
}

function PodcastPlayer() {
  const { t, i18n } = useTranslation(),
    qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['discover', 'podcast'],
    queryFn: () => api.discover.podcast(),
    staleTime: 0,
    refetchInterval: 60000
  })
  const supported = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined'
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]),
    [voiceId, setVoiceId] = useState(''),
    [rate, setRate] = useState(1)
  const [index, setIndex] = useState(0),
    [mode, setMode] = useState<'idle' | 'playing' | 'paused'>('idle'),
    [showScript, setShowScript] = useState(false)
  const token = useRef(0),
    current = useRef<SpeechSynthesisUtterance | null>(null)
  const script = data?.script,
    pending = data?.status === 'queued' || data?.status === 'running'
  useEffect(() => {
    const events = [
      'discover:changed',
      'notes:changed',
      'sources:changed',
      'review:changed',
      'mistakes:changed',
      'settings:changed'
    ] as const
    const off = events.map((event) => window.jiweiEvents.on(event, () => void qc.invalidateQueries({ queryKey: ['discover', 'podcast'] })))
    return () => off.forEach((f) => f())
  }, [qc])
  useEffect(() => {
    if (!supported) return
    const load = (): void => setVoices(speechSynthesis.getVoices().filter((v) => /^(zh|en)(-|$)/i.test(v.lang)))
    load()
    speechSynthesis.addEventListener('voiceschanged', load)
    return () => speechSynthesis.removeEventListener('voiceschanged', load)
  }, [supported])
  useEffect(() => {
    // 重新生成、隐私失效、离开页面都结束旧稿；忽略 cancel 引发的旧回调。
    const reset = (): void => {
      token.current++
      current.current = null
      if (supported) speechSynthesis.cancel()
    }
    reset()
    setIndex(0)
    setMode('idle')
    return reset
  }, [script?.createdAt, supported])

  const cancel = (): void => {
    token.current++
    current.current = null
    if (supported) speechSynthesis.cancel()
  }
  const speak = (at: number, nextRate = rate, nextVoice = voiceId): void => {
    if (!supported || !script?.paragraphs[at]) return
    cancel()
    const request = token.current,
      utterance = new SpeechSynthesisUtterance(script.paragraphs[at])
    const voice =
      voices.find((v) => v.voiceURI === nextVoice) ?? voices.find((v) => v.lang.startsWith(i18n.language.startsWith('zh') ? 'zh' : 'en'))
    utterance.lang = voice?.lang ?? (i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US')
    if (voice) utterance.voice = voice
    utterance.rate = nextRate
    utterance.onend = () => {
      if (request !== token.current) return
      current.current = null
      if (at + 1 < script.paragraphs.length) speak(at + 1, nextRate, nextVoice)
      else setMode('idle')
    }
    utterance.onerror = () => {
      if (request !== token.current) return
      current.current = null
      setMode('idle')
      toast.error(t('discover.podcastSpeechError'))
    }
    current.current = utterance
    setIndex(at)
    setMode('playing')
    speechSynthesis.speak(utterance)
  }
  const seek = (at: number): void => {
    cancel()
    setIndex(at)
    if (mode === 'playing') speak(at)
  }
  const configure = (nextRate: number, nextVoice: string): void => {
    setRate(nextRate)
    setVoiceId(nextVoice)
    if (mode === 'playing') speak(index, nextRate, nextVoice)
    else cancel()
  }
  const generate = async (): Promise<void> => {
    try {
      await api.discover.podcastGenerate()
    } catch (e) {
      toast.error(String(e))
    }
  }
  return (
    <section className="paper mt-6 min-w-0 rounded-2xl border border-border p-5" data-testid="podcast-player">
      <div className="flex flex-wrap items-center gap-3">
        <Headphones className="size-4 text-accent" />
        <h2 className="min-w-0 flex-1 font-serif text-base font-semibold">{t('discover.podcast')}</h2>
        <Button size="sm" variant="outline" disabled={data?.status === 'running'} onClick={() => void generate()}>
          {t(script ? 'discover.podcastRegenerate' : 'discover.podcastGenerate')}
        </Button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">{t('discover.podcastHint')}</p>
      {pending && (
        <p role="status" className="mt-3 text-sm text-accent">
          {t(data?.status === 'queued' ? 'discover.podcastQueued' : 'discover.podcastGenerating')}
        </p>
      )}
      {data?.message && (
        <p role="status" className="mt-3 text-sm text-warning">
          {data.message}
        </p>
      )}
      {!script && !pending && !data?.message && <p className="mt-3 text-sm text-muted">{t('discover.podcastEmpty')}</p>}
      {!supported && <p className="mt-3 text-sm text-warning">{t('discover.podcastUnsupported')}</p>}
      {script && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('discover.podcastPrevious')}
              disabled={!supported || index === 0}
              onClick={() => seek(index - 1)}
            >
              <SkipBack />
            </Button>
            <Button
              size="sm"
              disabled={!supported}
              onClick={() => {
                if (mode === 'playing') {
                  speechSynthesis.pause()
                  setMode('paused')
                } else if (mode === 'paused' && current.current) {
                  speechSynthesis.resume()
                  setMode('playing')
                } else speak(index)
              }}
            >
              {mode === 'playing' ? <Pause /> : <Play />}
              {t(mode === 'playing' ? 'discover.podcastPause' : mode === 'paused' ? 'discover.podcastResume' : 'discover.podcastPlay')}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('discover.podcastNext')}
              disabled={!supported || index >= script.paragraphs.length - 1}
              onClick={() => seek(index + 1)}
            >
              <SkipForward />
            </Button>
            <span className="text-xs text-muted tabular-nums">
              {t('discover.podcastProgress', { current: index + 1, total: script.paragraphs.length })}
            </span>
            <label className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted">
              {t('discover.podcastRate')}
              <select
                aria-label={t('discover.podcastRate')}
                className="rounded-lg border border-border bg-surface px-2 py-1 text-fg"
                value={rate}
                onChange={(e) => configure(Number(e.target.value), voiceId)}
              >
                {[0.75, 1, 1.25, 1.5, 2].map((v) => (
                  <option key={v} value={v}>
                    {v}×
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 items-center gap-2 text-xs text-muted">
              {t('discover.podcastVoice')}
              <select
                aria-label={t('discover.podcastVoice')}
                className="max-w-52 min-w-0 rounded-lg border border-border bg-surface px-2 py-1 text-fg"
                value={voiceId}
                onChange={(e) => configure(rate, e.target.value)}
              >
                <option value="">{t('discover.podcastVoiceDefault')}</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} · {v.lang}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p data-testid="podcast-paragraph" className="mt-4 max-h-40 overflow-y-auto break-words text-sm leading-relaxed text-fg">
            {script.paragraphs[index]}
          </p>
          <Button className="mt-2" size="sm" variant="ghost" onClick={() => setShowScript(!showScript)}>
            {t(showScript ? 'discover.podcastHide' : 'discover.podcastText')}
          </Button>
          {showScript && (
            <div data-testid="podcast-script" className="mt-3 max-h-80 space-y-3 overflow-y-auto break-words text-sm leading-relaxed">
              {script.paragraphs.map((text, i) => (
                <p key={i}>{text}</p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
