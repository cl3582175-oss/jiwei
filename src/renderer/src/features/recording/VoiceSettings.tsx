import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Mic, Download, Trash2, Pencil, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { confirm, prompt } from '@/components/ui/confirm'

export function VoiceSettings() {
  const { t } = useTranslation(),
    qc = useQueryClient(),
    { data: status } = useQuery({ queryKey: ['voiceprint'], queryFn: () => api.voiceprint.status() })
  const { data: people = [] } = useQuery({ queryKey: ['people'], queryFn: () => api.people.list() }),
    { data: storage } = useQuery({ queryKey: ['recording-storage'], queryFn: () => api.recording.storage() }),
    { data: corrections = [], refetch: refreshCorrections } = useQuery({
      queryKey: ['corrections'],
      queryFn: () => api.people.corrections()
    })
  const [removeNames, setRemoveNames] = useState(false),
    [name, setName] = useState(''),
    [recording, setRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [computing, setComputing] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null),
    timer = useRef<number | undefined>(undefined),
    stream = useRef<MediaStream | null>(null)
  useEffect(() => window.jiweiEvents.on('voiceprint:status', (s) => qc.setQueryData(['voiceprint'], s)), [qc])
  useEffect(
    () =>
      window.jiweiEvents.on('people:changed', () => {
        void qc.invalidateQueries({ queryKey: ['people'] })
      }),
    [qc]
  )
  useEffect(
    () => () => {
      window.clearInterval(timer.current)
      if (recorder.current) {
        recorder.current.onstop = null
        if (recorder.current.state === 'recording') recorder.current.stop()
      }
      stream.current?.getTracks().forEach((t) => t.stop())
    },
    []
  )
  const enroll = async (): Promise<void> => {
    if (!(await api.recording.requestMic())) {
      toast.error(t('recording.micDenied'))
      return
    }
    stream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream.current, { mimeType: 'audio/webm;codecs=opus' }),
      parts: Blob[] = []
    recorder.current = rec
    rec.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data)
    }
    rec.onstop = () => {
      window.clearInterval(timer.current)
      stream.current?.getTracks().forEach((t) => t.stop())
      setRecording(false)
      setComputing(true)
      void (async () => {
        const bytes = new Uint8Array(await new Blob(parts).arrayBuffer())
        await api.voiceprint.enroll(bytes)
        toast(t('recording.enrolled'))
      })()
        .catch((e) => toast.error(String(e)))
        .finally(() => setComputing(false))
    }
    rec.start()
    setRecording(true)
    setSeconds(0)
    let elapsed = 0
    timer.current = window.setInterval(() => {
      setSeconds(++elapsed)
      if (elapsed >= 15) rec.stop()
    }, 1000)
  }
  return (
    <section className="space-y-4 rounded-xl border border-border p-4" data-testid="voice-settings">
      <h3 className="text-sm font-medium">{t('recording.voiceTitle')}</h3>
      <p className="text-xs text-muted">{t('recording.voiceDesc')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {status?.state !== 'ready' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={status?.state === 'downloading'}
            onClick={() => void api.voiceprint.install().catch((e) => toast.error(String(e)))}
          >
            <Download />
            {t('recording.installVoice')}
            {status?.state === 'downloading' && ` ${Math.round(status.progress * 100)}%`}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void api.voiceprint.remove().catch((e) => toast.error(String(e)))}>
            <Trash2 />
            {t('recording.removeVoice')}
          </Button>
        )}
        <span className="text-2xs text-muted">{formatBytes(status?.size ?? 0)}</span>
      </div>
      {status?.message && (
        <p role="alert" className="text-xs text-danger">
          {status.message}
        </p>
      )}
      <div className="space-y-2">
        <p className="rounded-lg bg-sunken p-3 text-xs leading-relaxed">{t('recording.readPrompt')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={status?.state !== 'ready' || computing || recording}
            onClick={() => void enroll().catch((e) => toast.error(String(e)))}
          >
            <Mic />
            {t('recording.enroll')}
          </Button>
          {recording && (
            <Button size="sm" variant="ghost" disabled={seconds < 10} onClick={() => recorder.current?.stop()}>
              {t('recording.stopEnroll')} {seconds}s
            </Button>
          )}
          {computing && (
            <span className="flex items-center gap-2 text-xs">
              <Loader2 className="size-3 animate-spin" />
              {t('recording.enrolling')}
            </span>
          )}
          {people.some((p) => p.isMe && p.voiceprints) && (
            <Button size="sm" variant="ghost" onClick={() => void api.people.clear(false, people.find((p) => p.isMe)!.id)}>
              <Trash2 />
              {t('recording.deleteMe')}
            </Button>
          )}
        </div>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-medium">{t('recording.managePeople')}</h4>
        <div className="flex gap-2">
          <Input aria-label={t('recording.newPerson')} value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" variant="ghost" disabled={!name.trim()} onClick={() => void api.people.save({ name }).then(() => setName(''))}>
            {t('recording.add')}
          </Button>
        </div>
        {!people.length && <p className="mt-2 text-xs text-subtle">{t('recording.noPeople')}</p>}
        {people.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-1 border-b border-border py-2 text-xs">
            <span className="mr-auto">
              {p.name}
              {p.isMe && ` · ${t('recording.me')}`} · {p.voiceprints}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('recording.rename')}
              onClick={() =>
                void (async () => {
                  const name = await prompt({ title: t('recording.rename'), defaultValue: p.name })
                  if (name) await api.people.save({ ...p, name }, p.id)
                })().catch((e) => toast.error(String(e)))
              }
            >
              <Pencil />
            </Button>
            <select
              aria-label={t('recording.merge')}
              className="max-w-32 rounded border border-border bg-surface p-1"
              value=""
              onChange={(e) => void api.people.merge(p.id, e.target.value).catch((e) => toast.error(String(e)))}
            >
              <option value="">{t('recording.merge')}</option>
              {people
                .filter((x) => x.id !== p.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
            <Button variant="ghost" size="icon-sm" aria-label={t('recording.deletePerson')} onClick={() => void api.people.remove(p.id)}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={removeNames} onChange={(e) => setRemoveNames(e.target.checked)} />
          {t('recording.clearNames')}
        </label>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void confirm({ title: t('recording.clearTitle'), description: t('recording.clearDesc'), danger: true }).then(async (yes) => {
              if (yes) await api.people.clear(removeNames)
            })
          }
        >
          {t('recording.clearPrints')}
        </Button>
      </div>
      <div>
        <h4 className="mb-1 text-xs font-medium">
          {t('recording.storage')} · {formatBytes(storage?.bytes ?? 0)}
        </h4>
        <p className="text-2xs text-subtle">{t('recording.savedLocal')}</p>
        {storage?.recordings
          .filter((r) => r.bytes > 0)
          .map((r) => (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" key={r.id}>
              <span className="mr-auto">
                {r.id.slice(0, 8)} · {formatBytes(r.bytes)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void confirm({ title: t('recording.deleteAudioTitle'), description: t('recording.deleteAudioDesc'), danger: true }).then(
                    async (yes) => {
                      if (yes) {
                        await api.recording.deleteAudio(r.id)
                        void qc.invalidateQueries({ queryKey: ['recording-storage'] })
                      }
                    }
                  )
                }
              >
                {t('recording.deleteAudio')}
              </Button>
            </div>
          ))}
      </div>
      <div>
        <h4 className="mb-2 text-xs font-medium">{t('recording.corrections')}</h4>
        {!corrections.length && <p className="text-xs text-subtle">{t('recording.noCorrections')}</p>}
        {corrections.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-xs">
            <span className="mr-auto">
              {c.from} → {c.to} · {c.count}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('recording.discard')}
              onClick={() => void api.people.removeCorrection(c.id).then(() => refreshCorrections())}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}
