import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ReadingTarget, ReadingWord, VocabularyLanding } from '@shared/reading'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { applyReviewedDocument } from '../inbox/documents'
import { readingStateKey } from './ReadingControls'
import { readingWordEvent } from './ReadingText'

let queue:Promise<unknown>=Promise.resolve()
export function saveVocabulary(word:ReadingWord,concept=false):Promise<VocabularyLanding> {
  const run=queue.then(async()=>{
    const landing=await api.reading.prepare({...word,concept})
    if(landing.proposalId)await applyReviewedDocument(landing.noteId,landing.proposalId,(update)=>api.reading.complete(landing.proposalId!,update))
    return landing
  })
  queue=run.catch(()=>undefined)
  return run
}
export function WordCard({target}:{target:ReadingTarget}) {
  const {t}=useTranslation(),qc=useQueryClient(),[word,setWord]=useState<ReadingWord|null>(null),[busy,setBusy]=useState(false),[saved,setSaved]=useState<string|null>(null),[confirm,setConfirm]=useState<boolean|null>(null)
  useEffect(()=>window.jiweiEvents.on('reading:word',(value)=>{if(value.target.kind===target.kind&&value.target.id===target.id){setWord(value);setSaved(null);setConfirm(null)}}),[target.kind,target.id])
  useEffect(()=>{
    const show=(event:Event):void=>{const value=(event as CustomEvent<ReadingWord>).detail;if(value.target.kind===target.kind&&value.target.id===target.id){setWord(value);setSaved(null);setConfirm(null)}}
    window.addEventListener(readingWordEvent,show);return ()=>window.removeEventListener(readingWordEvent,show)
  },[target.kind,target.id])
  const save=async(concept:boolean):Promise<void>=>{
    if(!word)return
    setBusy(true)
    try{const result=await saveVocabulary(word,concept);setSaved(result.noteId);setConfirm(null);void qc.invalidateQueries({queryKey:['notes']});void qc.invalidateQueries({queryKey:['categories']});toast.success(t('reading.saved'))}
    catch(e){toast.error(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  return <Dialog open={!!word} onOpenChange={(open)=>!open&&setWord(null)}><DialogContent title={word?.word ?? t('reading.wordCard')}>
    <div data-testid="reading-word-card"><p className="mt-2 text-lg font-medium text-accent">{word?.gloss}</p><p className="mt-5 text-xs font-semibold tracking-wide text-muted">{t('reading.example')}</p><p className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-sunken/70 px-3.5 py-2.5 break-words text-sm leading-relaxed text-fg">{word?.sentence}</p>
      {confirm!==null?<><p className="mt-4 text-xs text-muted">{t('reading.pendingHint')}</p><div className="mt-4 flex flex-wrap justify-end gap-2"><Button size="sm" variant="ghost" onClick={()=>setConfirm(null)}>{t('reading.cancel')}</Button><Button variant="primary" size="sm" disabled={busy} onClick={()=>void save(confirm)}>{t('reading.confirm')}</Button></div></>:<div className="mt-5 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={()=>{if(!word)return;setBusy(true);void api.reading.recognize(word.word).then(async()=>{toast.success(t('reading.recognized'));const current=await api.reading.state(target);await api.reading.configure({target,mode:current.mode,annotations:current.annotations});void qc.invalidateQueries({queryKey:['vocabulary-profile']});void qc.invalidateQueries({queryKey:readingStateKey(target)});setWord(null)}).catch((e:Error)=>toast.error(e.message)).finally(()=>setBusy(false))}}>{t('reading.recognize')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={()=>setConfirm(false)}>{t('reading.addWord')}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={()=>setConfirm(true)}>{t('reading.addConcept')}</Button>
      </div>}
      {saved&&<Button variant="ghost" size="sm" className="mt-3" onClick={()=>{useApp.getState().openNote(saved);setWord(null)}}>{t('reading.openNote')}</Button>}
    </div>
  </DialogContent></Dialog>
}
