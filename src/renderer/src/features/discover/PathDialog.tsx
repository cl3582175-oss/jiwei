import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog as D } from 'radix-ui'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import type { Goal } from '@shared/types'
import type { LearningPath } from '@shared/discover'
import type { SchedulePreview } from '@shared/plan'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
export function PathDialog({ goal, close }: { goal: Goal; close: () => void }) {
  const { t, i18n } = useTranslation(),
    [path, setPath] = useState<LearningPath | null>(null),
    [preview, setPreview] = useState<SchedulePreview | null>(null),
    [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <D.Root open onOpenChange={(v) => !v && !busy && close()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <D.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(94vw,720px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-float"
          data-testid="path-dialog"
        >
          <D.Title className="font-serif text-lg">
            {t('discover.pathTitle')} · {goal.title}
          </D.Title>
          <D.Description className="mt-2 text-xs text-muted">{t('discover.pathHint')}</D.Description>
          {busy && (
            <p className="mt-4 flex items-center gap-2 text-sm text-accent">
              <Loader2 className="size-4 animate-spin" />
              {t('discover.pathGenerating')}
            </p>
          )}
          {!path ? (
            <Button
              className="mt-5"
              variant="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setPath(await api.discover.path(goal.id))
                })
              }
            >
              {t('discover.path')}
            </Button>
          ) : (
            <div className="mt-5 space-y-3">
              {path.steps.map((s, i) => (
                <article key={i} className="rounded-xl border border-border p-3">
                  <h3 className="break-words text-sm font-medium">
                    {i + 1}. {s.title}
                  </h3>
                  <p className="mt-1 text-xs text-accent">{s.question}</p>
                  <p className="mt-1 break-words text-sm text-muted">{s.objective}</p>
                  <ul className="mt-2 space-y-1 text-xs">
                    {s.resources.map((r) => (
                      <li key={r.id} className="break-words">
                        {r.title} · {t(r.type === 'web' ? 'discover.web' : 'discover.knowledge')}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
          {preview && (
            <section className="mt-4 rounded-xl bg-sunken p-3" data-testid="path-phase-preview">
              <h3 className="text-sm font-medium">{t('discover.previewPhases')}</h3>
              <p className="mt-1 text-xs text-muted">{preview.tradeoffs}</p>
              <ol className="mt-2 space-y-1 text-xs">
                {preview.phases.map((p, i) => (
                  <li key={i}>
                    {p.title} · {new Date(p.startAt).toLocaleDateString(i18n.language)} –{' '}
                    {new Date(p.endAt - 1).toLocaleDateString(i18n.language)}
                  </li>
                ))}
              </ol>
            </section>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={close}>
              {t('discover.close')}
            </Button>
            {path && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  useApp.getState().openNote(path.noteId)
                  close()
                }}
              >
                {t('discover.openPath')}
              </Button>
            )}
            {path && !preview && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setPreview(await api.discover.pathPhases(path.id))
                  })
                }
              >
                {t('discover.phases')}
              </Button>
            )}
            {preview && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.plan.scheduleApply(preview.id)
                    close()
                  })
                }
              >
                {t('discover.applyPhases')}
              </Button>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
