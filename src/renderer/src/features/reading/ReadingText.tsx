import { useEffect, useRef, useState, Fragment, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { readingBatches, readingParts, type ReadingTarget, type ReadingParagraph, type ReadingResult, type ReadingWord } from '@shared/reading'
import type { Segment } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useReadingState } from './ReadingControls'
import { useSourceSelection } from '../workspace/SourcePane'

export const readingWordEvent='jiwei-reading-word'
export function showReadingWord(word:ReadingWord):void {window.dispatchEvent(new CustomEvent(readingWordEvent,{detail:word}))}

/** 资料沿真实分段读取，IntersectionObserver 的范围只向上下各扩两屏。 */
export function useViewportReading(target:ReadingTarget,paragraphs:ReadingParagraph[],root:RefObject<HTMLElement|null>) {
  const {data:state}=useReadingState(target),[results,setResults]=useState<Record<string,ReadingResult>>({}),[pending,setPending]=useState(false)
  const sourceKey=`${target.kind}:${target.id}`, version=`${sourceKey}:${state?.revision ?? 0}:${state?.mode ?? 'original'}:${state?.annotations ?? false}`
  const texts=paragraphs.map((p)=>`${p.id}:${p.text}`).join('\u0000')
  useEffect(()=>{
    const element=root.current
    setResults({})
    if(!element || !state?.foreign || (state.mode==='original'&&!state.annotations))return
    let stopped=false,busy=false,timer=0
    const visible=new Set<string>(),done=new Set<string>(),failed=new Set<string>()
    const scroll=element.closest<HTMLElement>('[data-reading-scroll]')
    const request=async():Promise<void>=>{
      if(stopped||busy)return
      const candidates=paragraphs.filter((p)=>visible.has(p.id)&&!done.has(p.id)&&!failed.has(p.id))
      if(!candidates.length)return
      busy=true;setPending(true)
      try{
        for(const batch of readingBatches(candidates)) {
          if(stopped)return
          const settings=await api.settings.get()
          const response=await api.reading.translate({target,paragraphs:batch,translation:state.mode!=='original',annotations:state.annotations,targetLanguage:settings.language})
          if(stopped)return
          setResults((old)=>({...old,...Object.fromEntries(response.paragraphs.map((p)=>[p.id,p]))}))
          batch.forEach((p)=>done.add(p.id))
        }
      }catch(e){if(!stopped){candidates.forEach((p)=>failed.add(p.id));toast.error(e instanceof Error?e.message:String(e))}}
      finally{busy=false;if(!stopped){setPending(false);timer=window.setTimeout(()=>void request(),350)}}
    }
    const height=scroll?.clientHeight ?? innerHeight
    const observer=new IntersectionObserver((entries)=>{for(const entry of entries){const id=(entry.target as HTMLElement).dataset.readingParagraph;if(id){if(entry.isIntersecting)visible.add(id);else visible.delete(id)}}void request()},{root:scroll,rootMargin:`${height*2}px 0px ${height*2}px 0px`})
    element.querySelectorAll<HTMLElement>('[data-reading-paragraph]').forEach((p)=>observer.observe(p))
    return ()=>{stopped=true;observer.disconnect();window.clearTimeout(timer);setPending(false)}
    // texts includes original segment edits; old requests cannot publish into the new view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[version,texts,root])
  return {state,results,pending}
}

export function ReadingParagraphUI({paragraph,pieces,result,mode,annotations,target,language,page}:{paragraph:ReadingParagraph;pieces?:{segment:string;text:string}[];result?:ReadingResult;mode:'original'|'parallel'|'translation';annotations:boolean;target:ReadingTarget;language:string;page?:string}) {
  const {t}=useTranslation(),[expanded,setExpanded]=useState(false)
  const glossList=annotations?result?.annotations ?? []:[]
  const glosses=new Map(glossList.map((annotation)=>[annotation.word.toLowerCase(),annotation])),used=new Set<string>()
  const show=(annotation:{word:string;gloss:string}):void=>showReadingWord({word:annotation.word,gloss:annotation.gloss,sentence:paragraph.text,language,target})
  // 生词只加虚线下划线，释义放在段落下方的生词条里，不叠在正文上。
  const words=(text:string,key:string)=>text.split(/([\p{L}][\p{L}'’-]*)/gu).map((part,index)=>{
    const annotation=glosses.get(part.toLowerCase())
    if(!annotation||used.has(part.toLowerCase()))return part
    used.add(part.toLowerCase())
    return <button key={`${key}:${index}`} type="button" title={annotation.gloss} className="inline select-text p-0 align-baseline text-inherit underline decoration-accent/60 decoration-dotted decoration-[1.5px] underline-offset-[5px] hover:bg-accent-soft" onMouseUp={(event)=>{if(!window.getSelection()?.toString())event.stopPropagation()}} onClick={()=>{if(!window.getSelection()?.toString())show(annotation)}}>{part}</button>
  })
  const hideOriginal=mode==='translation'&&!!result?.translation&&!expanded
  return <div className="min-w-0 max-w-full" data-reading-paragraph={paragraph.id}>
    {pieces&&pieces.length>1
      ? <p data-page={page} className={cn('whitespace-pre-wrap break-words',hideOriginal&&'hidden')}>{pieces.map((piece,i)=><Fragment key={piece.segment}>{i>0&&' '}<span data-segment={piece.segment}>{words(piece.text,piece.segment)}</span></Fragment>)}</p>
      : <p data-segment={paragraph.id.split(':')[0]} data-page={page} className={cn('whitespace-pre-wrap break-words',hideOriginal&&'hidden')}>{words(paragraph.text,'p')}</p>}
    {mode!=='original'&&result?.translation&&<div data-jiwei-ui="translation" data-testid="reading-translation" className="mt-2 mb-4 max-w-full cursor-pointer rounded-r-md border-l-[3px] border-accent/45 bg-accent-soft/45 px-3.5 py-2 text-[0.95em] leading-[1.8] whitespace-pre-wrap break-words text-fg/80" role="button" tabIndex={0} aria-label={t(expanded?'reading.hideOriginal':'reading.showOriginal')} onClick={()=>{if(!window.getSelection()?.toString())setExpanded(!expanded)}} onKeyDown={(event)=>event.key==='Enter'&&setExpanded(!expanded)}>{result.translation}</div>}
    {glossList.length>0&&<div data-jiwei-ui="vocabulary" data-testid="reading-annotations" className="mt-1.5 mb-4 flex flex-wrap gap-1.5">
      {glossList.map((annotation)=><button key={annotation.word} type="button" onClick={()=>show(annotation)} className="inline-flex max-w-full items-baseline gap-1.5 rounded-full border border-accent/20 bg-accent-soft/60 px-2.5 py-0.5 text-[13px] leading-relaxed transition-colors hover:bg-accent-soft"><span className="font-semibold text-fg">{annotation.word}</span><span className="text-accent">{annotation.gloss}</span></button>)}
    </div>}
  </div>
}

const pageOf=(segment:Segment):string=>String((segment.locator as {value?:unknown}).value ?? '').match(/page=(\d+)/)?.[1] ?? ''
const ENDS=/[.!?:;。！？：；]["'”’)\]]?$/
/** PDF 文字层一行一段，逐行翻译会把句子拦腰截断（arXiv 实测）。阅读视图里把同一页连续的行并回段落：
 *  在句末断开、最多约 1200 字；每一行仍是自己的 data-segment，批注定位不受影响。 */
function pdfParagraphs(segments:Segment[]):ReadingSourceParagraph[] {
  const lines=segments.filter((s)=>s.kind!=='code'&&s.text.trim()),out:ReadingSourceParagraph[]=[]
  let group:Segment[]=[]
  const flush=():void=>{
    if(!group.length)return
    out.push({id:group.length===1?`${group[0].id}:0`:`${group[0].id}:m${group.length}`,text:group.map((s)=>s.text.trim()).join(' '),segment:group[0],pieces:group.map((s)=>({segment:s.id,text:s.text.trim()}))})
    group=[]
  }
  for(const line of lines) {
    if(group.length&&pageOf(group[0])!==pageOf(line))flush()
    group.push(line)
    const length=group.reduce((n,s)=>n+s.text.length,0),text=line.text.trim()
    // 短而无标点的独立行（标题、图注编号）单独成段；句末或过长时结束本段。
    if(ENDS.test(text)||length>1200||(group.length===1&&text.length<60&&!/[,，]$/.test(text)))flush()
  }
  flush()
  return out
}
interface ReadingSourceParagraph extends ReadingParagraph {segment:Segment;pieces:{segment:string;text:string}[]}

export function ReadingSourceText({sourceId,segments,pdf=false}:{sourceId:string;segments:Segment[];pdf?:boolean}) {
  const {t}=useTranslation(),root=useRef<HTMLElement>(null),onSelect=useSourceSelection(sourceId),target:ReadingTarget={kind:'source',id:sourceId}
  const paragraphs=pdf?pdfParagraphs(segments):segments.filter((s)=>s.kind!=='code' && s.text.trim()).flatMap((s)=>readingParts(s.text).map((text,i)=>({id:`${s.id}:${i}`,text,segment:s,pieces:[{segment:s.id,text}]})))
  const reading=useViewportReading(target,paragraphs,root)
  return <article ref={root} className="source-text min-w-0 max-w-full select-text" onMouseUp={onSelect} onKeyUp={onSelect} data-testid={pdf?'reading-pdf-text':'reading-source-text'}>
    {reading.pending&&<p data-jiwei-ui="reading-status" className="sticky top-2 z-10 mx-auto mb-3 flex w-fit items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-1 text-xs text-muted shadow-card"><Loader2 className="size-3 animate-spin" />{t('reading.translating')}</p>}
    {paragraphs.map((paragraph,index)=>{
      const page=pageOf(paragraph.segment)||undefined, previous=index?pageOf(paragraphs[index-1].segment):null
      return <Fragment key={paragraph.id}>{pdf&&page&&page!==previous&&<h4 data-jiwei-ui="page-label" className="mt-8 mb-3 border-b border-border pb-1.5 text-xs font-medium tracking-wide text-subtle first:mt-0">{t('reading.pdfPage',{page})}</h4>}<div data-page={page} className="min-w-0"><ReadingParagraphUI paragraph={paragraph} pieces={paragraph.pieces} result={reading.results[paragraph.id]} mode={reading.state?.mode ?? 'original'} annotations={reading.state?.annotations ?? false} target={target} language={reading.state?.language ?? 'en'} page={page} /></div></Fragment>
    })}
  </article>
}
