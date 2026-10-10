import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Flag, Loader2, Sparkles } from 'lucide-react'
import type { MistakePractice } from '@shared/mistakes'
import type { AnswerCheck, ReviewCard, ReviewRating } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { errText } from '../chat/useChat'
import { RichMistake } from './RichMistake'

export function MistakePracticeDialog({ id, open, close }: { id: string; open: boolean; close: () => void }) {
  const { t } = useTranslation()
  const [practice, setPractice] = useState<MistakePractice | null>(null), [card, setCard] = useState<ReviewCard | null>(null)
  const [answer, setAnswer] = useState(''), [revealed, setRevealed] = useState(false), [check, setCheck] = useState<AnswerCheck | null>(null), [busy, setBusy] = useState(false)
  const shownAt = useRef(Date.now())
  useEffect(() => {
    if (!open) return
    let alive = true
    setAnswer(''); setRevealed(false); setCheck(null); setPractice(null); shownAt.current = Date.now()
    void (async () => {
      try {
        const [p, m] = await Promise.all([api.mistakes.practice(id), api.mistakes.get(id)])
        if (!alive) return
        setPractice(p)
        const cards = m?.noteId ? await api.review.forNote(m.noteId) : []
        const found = cards.find((c) => c.rowId === m?.rowId)
        const review = found ? await api.review.get(found.id) : null
        if (alive) setCard(review)
      } catch (e) { if (alive) toast.error(errText(e)) }
    })()
    return () => { alive = false }
  }, [id, open])
  const runCheck = async (): Promise<void> => {
    if (!practice || !answer.trim()) return
    setBusy(true); setRevealed(true)
    try { setCheck(await api.mistakes.check(id, practice.variantId, answer.trim())) } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
  }
  const rate = async (rating: ReviewRating): Promise<void> => {
    if (!card || !practice) return
    setBusy(true)
    try { await api.review.rate(card.id, rating, Date.now() - shownAt.current, practice.variantId); toast.success(t('mistakes.donePractice')); close() } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
  }
  const flag = async (): Promise<void> => {
    if (!practice?.variantId) return
    setBusy(true)
    try { setPractice(await api.mistakes.flag(practice.variantId)); setAnswer(''); setCheck(null); setRevealed(false); shownAt.current = Date.now(); toast(t('mistakes.flagged')) } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={(o) => { if (!o) close() }}><DialogContent title={t('mistakes.practice')} className="max-h-[88vh] w-[min(92vw,680px)] overflow-y-auto">
    {!practice ? <Loader2 className="mx-auto mt-8 mb-4 size-5 animate-spin text-muted" /> : <div className="mt-4 min-w-0" data-testid="mistake-practice">
      <div className="mb-3 flex items-center gap-2">
        <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', practice.variantId ? 'bg-accent-soft text-accent' : 'bg-sunken text-muted')}>{t(practice.variantId ? 'mistakes.generated' : 'mistakes.originalOnly')}</span>
        {practice.variantId && <Button className="ml-auto text-muted" variant="ghost" size="sm" onClick={() => void flag()} disabled={busy}><Flag />{t('mistakes.flag')}</Button>}
      </div>
      {practice.fallback && <p className="mb-3 rounded-lg bg-sunken px-3.5 py-2.5 text-sm leading-relaxed text-muted">{t(`mistakes.fallback.${practice.fallback}`)}</p>}
      <div className="rounded-xl border border-border bg-paper px-5 py-4"><RichMistake text={practice.question} className="text-base leading-[1.8] text-fg" /></div>
      {!revealed ? <>
        <label className="mt-5 block text-sm font-medium text-fg">{t('mistakes.answer')}<textarea aria-label={t('mistakes.answer')} className="mt-2 w-full resize-y rounded-lg border border-border bg-surface p-3 text-sm leading-relaxed text-fg outline-none focus:border-accent" rows={4} value={answer} maxLength={3000} placeholder={t('mistakes.answerHint')} onChange={(e) => setAnswer(e.target.value)} /></label>
        <div className="mt-3 flex flex-wrap justify-end gap-2">{answer.trim() && <Button variant="outline" disabled={busy} onClick={() => void runCheck()}><Sparkles />{t('mistakes.check')}</Button>}<Button variant="primary" onClick={() => setRevealed(true)}>{t('mistakes.reveal')}</Button></div>
      </> : <>
        <div className="mt-5 border-l-[3px] border-accent/60 pl-4" data-testid="mistake-practice-answer">
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted">{t('mistakes.correctAnswer')}</p>
          {practice.answer && <RichMistake text={practice.answer} className="text-[15px] font-medium text-fg" />}
          {practice.solution && <RichMistake text={practice.solution} className="mt-2 text-[15px] text-fg/85" />}
        </div>
        {busy && <p className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 className="size-3.5 animate-spin" />{t('mistakes.checking')}</p>}
        {check && <div className="mt-4 rounded-xl bg-accent-soft px-4 py-3 text-sm leading-relaxed text-fg" data-testid="mistake-practice-check"><p>{check.verdict}</p>{[...check.missing, ...check.wrong].map((s, i) => <p key={i} className="mt-1 text-muted">· {s}</p>)}</div>}
        {card && <div className="mt-5 grid grid-cols-4 gap-2">{([1, 2, 3, 4] as const).map((r) => <Button key={r} variant={check?.suggested === r ? 'primary' : 'outline'} disabled={busy} onClick={() => void rate(r)}>{t(`review.rating.${r}`)}</Button>)}</div>}
      </>}
      <details className="group mt-6 border-t border-border pt-3"><summary className="cursor-pointer list-none text-sm text-muted hover:text-fg">{t('mistakes.seeOriginal')}</summary><div className="mt-3 space-y-3 rounded-xl bg-sunken/60 px-4 py-3"><RichMistake text={practice.original.question} className="text-sm text-fg" />{practice.original.answer && <RichMistake text={practice.original.answer} className="text-sm text-muted" />}</div></details>
      {practice.fallback === 'empty' && <Button className="mt-3" size="sm" variant="ghost" onClick={() => void api.mistakes.replenish(id, true).then(async () => { toast(t('mistakes.preparing')); setPractice(await api.mistakes.practice(id)) }).catch((e) => toast.error(errText(e)))}>{t('mistakes.prepareVariant')}</Button>}
    </div>}
  </DialogContent></Dialog>
}
