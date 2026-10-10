import { create } from 'zustand'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ActionItem } from '@shared/types'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { fmtTime } from '@shared/context'

const usePages = create<{ personId: string | null; seriesId: string | null }>()(() => ({ personId: null, seriesId: null }))
export const openPersonPage = (personId: string): void => usePages.setState({ personId, seriesId: null })
export const openSeriesPage = (seriesId: string): void => usePages.setState({ seriesId, personId: null })
function ActionList({ actions, refresh }: { actions: ActionItem[]; refresh: () => unknown }) {
  return (
    <div className="space-y-2">
      {actions.map((a) => (
        <label key={a.id} className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            aria-label={a.title}
            checked={a.status === 'done'}
            onChange={(e) =>
              void api.actions
                .update(a.id, { status: e.target.checked ? 'done' : 'open' })
                .then(refresh)
                .catch((e) => toast.error(String(e)))
            }
          />
          <span>
            {a.title}
            {a.ownerName && ` · ${a.ownerName}`}
          </span>
        </label>
      ))}
    </div>
  )
}
export function LensPages() {
  const { t } = useTranslation(),
    { personId, seriesId } = usePages(),
    [note, setNote] = useState('')
  const { data: person, refetch: refreshPerson } = useQuery({
      queryKey: ['person-page', personId],
      queryFn: () => api.people.page(personId!),
      enabled: !!personId
    }),
    { data: series, refetch: refreshSeries } = useQuery({
      queryKey: ['series-page', seriesId],
      queryFn: () => api.series.detail(seriesId!),
      enabled: !!seriesId
    })
  useEffect(() => {
    setNote(person?.person?.note ?? '')
  }, [person?.person?.note, personId])
  const close = (): void => usePages.setState({ personId: null, seriesId: null })
  const jump = (sourceId: string, at?: number): void => {
    close()
    useApp.getState().openSource(sourceId)
    if (at !== undefined) useApp.getState().setHighlight({ type: 'segment', id: '', locator: `t=${at}` })
  }
  return (
    <Dialog open={!!personId || !!seriesId} onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={personId ? (person?.person?.name ?? t('personPage.title')) : (series?.series.name ?? t('series.title'))}
        className="w-[min(92vw,720px)]"
      >
        <div className="mt-4 max-h-[65vh] space-y-5 overflow-y-auto pr-1" data-testid={personId ? 'person-page' : 'series-page'}>
          {personId && person && (
            <>
              {!person.person && <p className="text-xs text-muted">{t('personPage.missing')}</p>}
              <section>
                <h3 className="mb-2 text-sm font-medium">{t('personPage.recordings')}</h3>
                {person.sources.map((s) => (
                  <Button
                    key={s.id}
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start whitespace-normal text-left"
                    onClick={() => jump(s.id)}
                  >
                    {s.title}
                  </Button>
                ))}
              </section>
              <section>
                <h3 className="mb-2 text-sm font-medium">{t('personPage.actions')}</h3>
                <ActionList actions={person.actions} refresh={refreshPerson} />
              </section>
              <section>
                <h3 className="mb-2 text-sm font-medium">{t('personPage.viewpoints')}</h3>
                {person.viewpoints.map((v) => (
                  <div key={`${v.derivationId}:${v.item.id}`} className="mb-2 rounded-lg border border-border p-3 text-xs">
                    <p>{v.item.body}</p>
                    <Button variant="ghost" size="sm" onClick={() => jump(v.sourceId, v.t)}>
                      {v.title} · {fmtTime(v.t)}
                    </Button>
                  </div>
                ))}
              </section>
              {person.person && (
                <section>
                  <h3 className="mb-2 text-sm font-medium">{t('personPage.note')}</h3>
                  <textarea
                    className="w-full rounded-lg border border-border bg-surface p-2 text-sm"
                    aria-label={t('personPage.note')}
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void api.people
                        .save({ ...person.person!, note }, personId)
                        .then(() => refreshPerson())
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    {t('personPage.save')}
                  </Button>
                </section>
              )}
            </>
          )}
          {seriesId && series && (
            <>
              <p className="text-xs text-muted">
                {t('series.summary', { done: series.actions.filter((a) => a.status === 'done').length, total: series.actions.length })}
              </p>
              <section>
                <h3 className="mb-2 text-sm font-medium">{t('series.recordings')}</h3>
                {series.sources.map((s) => (
                  <Button variant="ghost" key={s.id} size="sm" className="w-full justify-start" onClick={() => jump(s.id)}>
                    {s.title}
                  </Button>
                ))}
              </section>
              <section>
                <h3 className="mb-2 text-sm font-medium">{t('series.actions')}</h3>
                <ActionList actions={series.actions} refresh={refreshSeries} />
              </section>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
