import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Languages, Check, BookOpenText } from 'lucide-react'
import { toast } from 'sonner'
import { DEFAULT_VOCAB_THRESHOLD, VOCAB_LEVELS, type ReadingTarget, type ReadingState, type ReadingEstimate, type ReadingMode } from '@shared/reading'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator, Dialog, DialogContent } from '@/components/ui/primitives'
import { WordCard } from './WordCard'

export const readingStateKey=(target:ReadingTarget):string[]=>['reading-state',target.kind,target.id]
export function useReadingState(target:ReadingTarget) {
  const {kind,id}=target
  const qc=useQueryClient(),query=useQuery({queryKey:readingStateKey(target),queryFn:()=>api.reading.state(target)})
  useEffect(()=>window.jiweiEvents.on('memory:changed',()=>{void qc.invalidateQueries({queryKey:['vocabulary-profile']})}),[qc])
  useEffect(()=>window.jiweiEvents.on('sources:changed',()=>{if(kind==='source')void qc.invalidateQueries({queryKey:readingStateKey({kind,id})})}),[qc,kind,id])
  return query
}
export function ReadingControls({target,state:supplied}:{target:ReadingTarget;state?:ReadingState|null}) {
  const {t}=useTranslation(),qc=useQueryClient(),query=useReadingState(target),state=supplied ?? query.data
  const [desired,setDesired]=useState<{mode:ReadingMode;annotations:boolean}|null>(null),[estimate,setEstimate]=useState<ReadingEstimate|null>(null),[threshold,setThreshold]=useState<number>(DEFAULT_VOCAB_THRESHOLD),[initial,setInitial]=useState(false),[skip,setSkip]=useState(false),[busy,setBusy]=useState(false)
  const change=async(mode:ReadingMode,annotations:boolean):Promise<void>=>{
    try {
      const settings=await api.settings.get()
      if((mode!=='original'||annotations)&&(!settings.ai.chat.providerId||!settings.ai.chat.model)) {
        toast.error(t('chat.needModel'),{action:{label:t('chat.setupModel'),onClick:()=>useApp.getState().openSettings('ai')}});return
      }
      const profile=await api.reading.profile()
      if((mode!=='original'||annotations)&&(!state?.skipCostPrompt||!profile.initialized)&&state?.mode==='original'&&!state.annotations) {
        setEstimate(await api.reading.estimate(target));setInitial(!profile.initialized);setThreshold(VOCAB_LEVELS.some((l)=>l.threshold===profile.threshold)?profile.threshold:DEFAULT_VOCAB_THRESHOLD);setSkip(state?.skipCostPrompt ?? false);setDesired({mode,annotations});return
      }
      await apply(mode,annotations)
    }catch(e){toast.error(e instanceof Error?e.message:String(e))}
  }
  const apply=async(mode:ReadingMode,annotations:boolean,first=false):Promise<void>=>{
    setBusy(true)
    try {const next=await api.reading.configure({target,mode,annotations,...(first?{skipCostPrompt:skip,...(initial?{initialThreshold:threshold}:{})}:{})});qc.setQueryData(readingStateKey(target),next);void qc.invalidateQueries({queryKey:['vocabulary-profile']});setDesired(null)}
    catch(e){toast.error(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  useEffect(()=>{if(supplied?.error)toast.error(supplied.error)},[supplied?.error])
  if(!state?.foreign)return null
  return <>
    <Menu><MenuTrigger asChild><Button variant={state.mode!=='original'||state.annotations?'secondary':'ghost'} size="sm" className="h-7 shrink-0 px-2 text-xs" aria-label={t('reading.title')} data-testid="reading-control"><Languages /><span className="hidden @min-[640px]:inline">{t('reading.title')}</span></Button></MenuTrigger><MenuContent>
      {(['original','parallel','translation'] as const).map((mode)=><MenuItem key={mode} disabled={busy} onSelect={()=>void change(mode,state.annotations)}>{state.mode===mode?<Check />:<span className="size-4" />}{t(`reading.${mode}`)}</MenuItem>)}
      {state.language==='en'&&<><MenuSeparator /><MenuItem disabled={busy} onSelect={()=>void change(state.mode,!state.annotations)}>{state.annotations?<Check />:<BookOpenText />}{t('reading.annotations')}</MenuItem></>}
      {state.error&&<><MenuSeparator /><MenuItem onSelect={()=>void apply(state.mode,state.annotations)}>{t('reading.retry')}</MenuItem></>}
    </MenuContent></Menu>
    <Dialog open={!!desired} onOpenChange={(open)=>!open&&setDesired(null)}><DialogContent title={t('reading.costTitle')}>
      <p className="mt-3 text-sm leading-relaxed text-muted">{t('reading.cost',{characters:estimate?.characters ?? 0,paragraphs:estimate?.paragraphs ?? 0,cost:estimate?.cost===null?t('reading.unknownCost'):`$${(estimate?.cost ?? 0).toFixed(4)}`})}</p>
      {initial&&<fieldset className="mt-5"><legend className="text-sm font-medium text-fg">{t('reading.initialLevel')}</legend><p className="mt-1 text-xs leading-relaxed text-muted">{t('reading.initialLevelHint')}</p>
        <div role="radiogroup" aria-label={t('reading.initialLevel')} className="mt-3 grid grid-cols-2 gap-2">{VOCAB_LEVELS.map((level)=><button key={level.id} type="button" role="radio" aria-checked={threshold===level.threshold} onClick={()=>setThreshold(level.threshold)} className={cn('rounded-xl border px-3.5 py-2.5 text-left transition-colors',threshold===level.threshold?'border-accent bg-accent-soft':'border-border hover:bg-surface-hover')}><span className="block text-sm font-medium text-fg">{t(`reading.levels.${level.id}`)}</span><span className="block text-xs text-muted">{t(`reading.levelHints.${level.id}`)}</span></button>)}</div>
      </fieldset>}
      <label className="mt-5 flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={skip} onChange={(event)=>setSkip(event.target.checked)} />{t('reading.skipCost')}</label>
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={()=>setDesired(null)}>{t('reading.cancel')}</Button><Button variant="primary" disabled={busy} onClick={()=>desired&&void apply(desired.mode,desired.annotations,true)}>{t('reading.start')}</Button></div>
    </DialogContent></Dialog>
    <WordCard target={target} />
  </>
}
