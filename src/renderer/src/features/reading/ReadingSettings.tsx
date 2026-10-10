import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, formatBytes } from '@/lib/utils'
import { VOCAB_LEVELS } from '@shared/reading'
import { Button } from '@/components/ui/button'

export function VocabularySettings() {
  const {t}=useTranslation(),qc=useQueryClient(),{data:profile}=useQuery({queryKey:['vocabulary-profile'],queryFn:()=>api.reading.profile()})
  const [value,setValue]=useState<number|null>(null),[busy,setBusy]=useState(false)
  if(!profile)return null
  return <section className="space-y-3" data-testid="vocabulary-settings">
    <div><h3 className="text-sm font-medium">{t('reading.threshold')}</h3><p className="mt-1 text-xs leading-relaxed text-muted">{t('reading.thresholdHint')}</p></div>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={t('reading.thresholdValue')} value={value ?? profile.threshold} onChange={(event)=>setValue(Number(event.target.value))} className="h-9 rounded-lg border border-border bg-surface px-2.5 text-sm text-fg outline-none focus:border-accent">
        {VOCAB_LEVELS.map((level)=><option key={level.id} value={level.threshold}>{t(`reading.levels.${level.id}`)} · {t(`reading.levelHints.${level.id}`)}</option>)}
        {!VOCAB_LEVELS.some((level)=>level.threshold===(value ?? profile.threshold))&&<option value={value ?? profile.threshold}>{t('reading.customLevel',{count:value ?? profile.threshold})}</option>}
      </select>
      <Button variant="secondary" size="sm" disabled={busy || value===null || value===profile.threshold} onClick={()=>{setBusy(true);void api.reading.setThreshold(value ?? profile.threshold).then(()=>{setValue(null);return qc.invalidateQueries({queryKey:['vocabulary-profile']})}).catch((e:Error)=>toast.error(e.message)).finally(()=>setBusy(false))}}>{t('reading.saveThreshold')}</Button>
    </div>
    <p className="text-xs text-muted">{t('reading.signals',{count:profile.pendingSignals})} · {t('reading.known',{count:profile.knownWords.length})}</p>
    <details className="text-xs"><summary className="cursor-pointer font-medium">{t('reading.history')}</summary><div className="mt-2 max-h-40 space-y-2 overflow-auto">
      {!profile.history.length&&<p className="text-muted">{t('reading.noHistory')}</p>}
      {[...profile.history].reverse().map((entry,index)=><p key={`${entry.at}:${index}`} className="text-muted"><span className="tabular-nums">{new Date(entry.at).toLocaleDateString()} · {entry.before} → {entry.after}</span> · {entry.reason==='manual'?t('reading.manual'):t('reading.automatic',{known:entry.recognized,queried:entry.queried})}</p>)}
    </div></details>
  </section>
}
export function TranslationCacheSettings() {
  const {t}=useTranslation(),qc=useQueryClient(),{data}=useQuery({queryKey:['translation-cache'],queryFn:()=>api.reading.cacheStats()}),[busy,setBusy]=useState(false)
  return <section className="space-y-3" data-testid="translation-cache-settings"><h3 className="text-sm font-medium">{t('reading.cache')}</h3><p className="text-xs text-muted">{t('reading.cacheHint')}</p><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-subtle">{t('reading.cacheSize',{entries:data?.entries ?? 0,size:formatBytes(data?.bytes ?? 0)})}</p><Button variant="secondary" size="sm" disabled={busy} onClick={()=>{setBusy(true);void api.reading.clearCache().then(()=>{toast.success(t('reading.cacheCleared'));return qc.invalidateQueries({queryKey:['translation-cache']})}).catch((e:Error)=>toast.error(e.message)).finally(()=>setBusy(false))}}>{t('reading.clearCache')}</Button></div></section>
}
