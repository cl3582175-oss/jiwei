import { NativeSelect } from '@/components/ui/native-select'
import { Checkbox } from '@/components/ui/checkbox'
import { PicksView } from '../discover/PicksView'
import { requestPhoneUpload } from '../capture/PhoneDialog'
import { useMoney } from '@/lib/money'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Inbox, FileText, Image, Trash2, Sparkles, Check, Smartphone, PenLine } from 'lucide-react'
import { toast } from 'sonner'
import type { InboxItem } from '@shared/inbox'
import { api, cn, formatRelative } from '@/lib/utils'
import { useSettings } from '@/lib/queries'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/shadcn-button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { NotePicker } from '../notes/NotePicker'
import { applyInboxDocument } from './documents'

export function useInbox() {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('inbox:changed', () => {
        void qc.invalidateQueries({ queryKey: ['inbox'] })
        void qc.invalidateQueries({ queryKey: ['inboxEstimate'] })
      }),
    [qc]
  )
  return useQuery({ queryKey: ['inbox'], queryFn: () => api.inbox.list() })
}
export function InboxView() {
  const money = useMoney()
  const { t, i18n } = useTranslation(),
    { data: items = [] } = useInbox(),
    { data: settings } = useSettings()
  const { data: cost } = useQuery({ queryKey: ['inboxEstimate'], queryFn: () => api.inbox.estimate() })
  const [busy, setBusy] = useState(false),
    [pick, setPick] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [tab, setTab] = useState<'captures' | 'picks'>('captures')
  const regular = items.filter((i) => i.kind !== 'pick')
  const qc = useQueryClient()
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['inbox'] })
    }
  }
  const accept = async (id: string, manual?: Parameters<typeof api.inbox.accept>[1]): Promise<void> => {
    const item = await api.inbox.accept(id, manual)
    if (item.filedTo?.noteId && item.filedTo.proposalId && item.status !== 'filed')
      await applyInboxDocument(item.filedTo.noteId, item.filedTo.proposalId)
    if (item.filedTo?.mistakeIds?.length) {
      useApp.getState().setReviewTab('mistakes')
      useApp.getState().setView('review')
    }
  }
  const remove = async (item: InboxItem): Promise<void> => {
    await api.inbox.remove(item.id)
    toast(t('inbox.deleted'), {
      action: {
        label: t('inbox.undo'),
        onClick: () => {
          void api.inbox.restore(item.id).catch((e: Error) => toast.error(e.message))
        }
      }
    })
  }
  const pending = regular.filter((i) => i.status === 'new' || i.status === 'suggested').length
  const visible = showAll ? regular : regular.filter((i) => i.status === 'new' || i.status === 'suggested')
  return (
    <Tabs asChild className="gap-0" value={tab} onValueChange={(value) => { if (value === 'captures' || value === 'picks') setTab(value) }}>
    <div className="flex h-full flex-col overflow-hidden" data-testid="inbox-view">
      <header className="drag flex shrink-0 flex-wrap items-end gap-x-4 gap-y-3 px-8 pb-5 pt-12">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2.5 font-serif text-xl font-semibold">
            <Inbox className="size-5 text-accent" />
            {t('inbox.title')}
            {pending > 0 && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-sans text-xs font-medium text-accent">{pending}</span>
            )}
          </h1>
        </div>
        <div className="no-drag flex flex-wrap items-center gap-1.5">
          {tab === 'captures' && <>
          <Button variant="ghost" onClick={requestPhoneUpload}>
            <Smartphone />
            {t('capture.phone')}
          </Button>
          <Button variant="ghost" onClick={() => void api.capture.open('text')}>
            <PenLine />
            {t('capture.title')}
          </Button>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <Button
            variant="secondary"
            disabled={busy || !regular.some((i) => i.status === 'suggested')}
            onClick={() =>
              void run(async () => {
                for (const i of regular) if (i.status === 'suggested') await accept(i.id)
              })
            }
          >
            <Check />
            {t('inbox.acceptAll')}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            title={
              !settings?.ai.chat.model
                ? t('inbox.noModel')
                : cost == null
                  ? t('inbox.costUnknown')
                  : t('inbox.cost', { cost: money.format(cost) })
            }
            onClick={() => (settings?.ai.chat.model ? void run(() => api.inbox.triage()) : useApp.getState().openModelSetup())}
          >
            <Sparkles />
            {t('inbox.triage')}
          </Button>
          </>}
        </div>
      </header>
      <TabsList variant="line" aria-label={t('inbox.title')} className="mb-4 h-auto w-full shrink-0 justify-start gap-2 border-b border-border px-8 pb-3">{(['captures', 'picks'] as const).map((key) => <TabsTrigger value={key} key={key} className="flex-none rounded-lg px-3 py-1.5 text-sm">{t(`discover.${key}`)}</TabsTrigger>)}</TabsList>
      <TabsContent value="picks" className="flex min-h-0 flex-1 flex-col"><PicksView inboxIds={new Set(items.filter((i) => i.kind === 'pick' && i.status === 'new').map((i) => i.id))} /></TabsContent>
      <TabsContent value="captures" asChild><div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        <div className="mx-auto max-w-3xl">
          <div className="mb-3 flex items-center justify-end border-b border-border pb-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
              <Checkbox

                className="accent-[var(--color-accent)]"
                checked={showAll}
                onCheckedChange={(nextChecked) => setShowAll((nextChecked === true))}
              />
              {t('inbox.showAll')}
            </label>
          </div>
          {!visible.length && (
            <div className="mx-auto max-w-md py-20 text-center">
              <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-accent-soft">
                <Inbox className="size-6 text-accent" />
              </div>
              <h2 className="font-serif text-lg">{t('inbox.empty')}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{t('inbox.emptyHint')}</p>
            </div>
          )}
          <div className="space-y-2.5">
            {visible.map((i) => {
              const origin = [i.origin.device === 'phone' ? t('inbox.phone') : '', i.origin.app, i.origin.windowTitle, i.origin.url].filter(
                Boolean
              )
              const body = i.text || i.recognized || t(`inbox.kind.${i.kind}`)
              const done = i.status === 'filed' || i.status === 'dismissed'
              return (
                <article
                  key={i.id}
                  data-testid={`inbox-${i.id}`}
                  className={cn(
                    'group min-w-0 rounded-xl border border-border bg-surface px-4 py-3.5 shadow-card transition-colors hover:border-border-strong',
                    done && 'opacity-60'
                  )}
                >
                  <div className="flex flex-wrap items-start gap-x-3.5 gap-y-2">
                    {i.assetMime?.startsWith('image/') && i.assetUrl ? (
                      <img
                        src={i.assetUrl}
                        alt={t('inbox.original')}
                        className="size-16 shrink-0 rounded-lg border border-border bg-sunken object-cover"
                      />
                    ) : (
                      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-subtle">
                        {i.kind === 'text' ? <FileText className="size-4" /> : <Image className="size-4" />}
                      </div>
                    )}
                    <div className="min-w-[12rem] flex-1">
                      <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{body}</p>
                      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                        <span
                          className={cn(
                            'rounded px-1.5 py-px',
                            i.status === 'suggested' ? 'bg-accent-soft text-accent' : 'bg-sunken text-muted'
                          )}
                        >
                          {t(`inbox.status.${i.status}`)}
                        </span>
                        {i.recognitionStatus !== 'none' && <span>{t(`inbox.recognition.${i.recognitionStatus}`)}</span>}
                        {origin.length > 0 && (
                          <span className="min-w-0 max-w-[24rem] truncate" title={origin.join(' · ')}>
                            {origin.join(' · ')}
                          </span>
                        )}
                        <span>{formatRelative(i.createdAt, i18n.language)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 self-center">
                      {i.assetMime?.startsWith('image/') && ['canceled', 'failed', 'unavailable'].includes(i.recognitionStatus) && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.inbox.retryRecognition(i.id))}>
                          {t('inbox.retryRecognition')}
                        </Button>
                      )}
                      {!done && !i.filedTo && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void run(() => api.inbox.update(i.id, { status: 'dismissed' }))}
                          >
                            {t('inbox.dismiss')}
                          </Button>
                          <NativeSelect
                            aria-label={t('inbox.change')}
                            value=""
                            disabled={busy}
                            className="h-7 max-w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-xs text-fg hover:bg-surface-hover"
                            onChange={(e) => {
                              const value = e.target.value
                              if (value === 'append_note') setPick(i.id)
                              else if (value === 'new_note' || value === 'save_source' || value === 'mistake' || value === 'keep')
                                void run(() => accept(i.id, { action: value }))
                            }}
                          >
                            <option value="">{t('inbox.change')}</option>
                            {(['append_note', 'new_note', 'save_source', 'mistake', 'keep'] as const).map((action) => (
                              <option key={action} value={action}>
                                {t(`inbox.action.${action}`)}
                              </option>
                            ))}
                          </NativeSelect>
                        </>
                      )}
                      {!done && (i.suggestion || i.filedTo) && (
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => accept(i.id))}>
                          <Check />
                          {t(i.filedTo ? 'inbox.retry' : i.suggestion?.action === 'mistake' ? 'mistakes.join' : 'inbox.accept')}
                        </Button>
                      )}
                      {i.status === 'filed' && i.filedTo?.noteId && (
                        <Button size="sm" variant="ghost" onClick={() => useApp.getState().openNote(i.filedTo!.noteId!)}>
                          {t('inbox.openNote')}
                        </Button>
                      )}
                      {i.status === 'filed' &&
                        i.filedTo?.sourceIds?.map((id) => (
                          <Button key={id} size="sm" variant="ghost" onClick={() => useApp.getState().openSource(id)}>
                            {t('inbox.openSource')}
                          </Button>
                        ))}
                      {(!i.filedTo || i.status === 'filed') && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="hover:text-danger"
                          aria-label={t('inbox.delete')}
                          title={t('inbox.delete')}
                          disabled={busy}
                          onClick={() => void run(() => remove(i))}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </div>
                  {i.suggestion && (
                    <div className="mt-3 flex gap-2 rounded-lg border-l-2 border-accent bg-accent-soft/60 px-3 py-2 text-sm">
                      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
                      <div className="min-w-0">
                        <span className="font-medium text-accent">{t(`inbox.action.${i.suggestion.action}`)}</span>
                        <span className="text-muted"> · {i.suggestion.reason}</span>
                        {i.suggestion.type === 'wrong_question' && <span className="text-muted"> · {t('inbox.wrongQuestion')}</span>}
                        {!!i.suggestion.groupWith?.length && (
                          <p className="mt-0.5 text-xs text-subtle">{t('inbox.group', { count: i.suggestion.groupWith.length + 1 })}</p>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </div>
      </div></TabsContent>
      <NotePicker
        open={!!pick}
        title={t('inbox.chooseNote')}
        onOpenChange={(open) => {
          if (!open) setPick(null)
        }}
        onPick={(noteId) => {
          const id = pick
          setPick(null)
          if (id) void run(() => accept(id, { action: 'append_note', noteId }))
        }}
      />
    </div>
    </Tabs>
  )
}
