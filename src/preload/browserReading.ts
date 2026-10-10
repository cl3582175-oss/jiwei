/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { ipcRenderer } from 'electron'
import { canonicalUrl } from '../shared/browserUrl'
import { normalizedReadingText, originalReadingText, readingParagraphs, readingParts, readingBatches, splitBreakParagraphs } from '../shared/readingText'
import type { ReadingState, ReadingResult, ReadingBatchResult } from '../shared/reading'

interface Config { allowed: boolean; state: ReadingState | null; url: string }
interface Paragraph { element: HTMLElement; id: string; text: string; key: string; part: number }

/** 沙箱中只接受主进程配置；网站拿不到 IPC、词汇档案或应用回调。 */
const READING_CSS=`:host{font:inherit;color:inherit}
.translation{display:block;font-size:.95em;line-height:1.75;color:#3f5f5a;background:rgba(70,135,129,.06);border-left:3px solid rgba(70,135,129,.45);border-radius:0 6px 6px 0;padding:6px 12px;margin:6px 0 14px;max-width:100%;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;cursor:pointer}
.translation:focus-visible{outline:2px solid #468781;outline-offset:2px}
.words{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 14px}
.translation+.words{margin-top:-6px}
.word{all:unset;box-sizing:border-box;display:inline-flex;align-items:baseline;gap:6px;max-width:100%;padding:3px 10px;border-radius:999px;background:rgba(70,135,129,.09);border:1px solid rgba(70,135,129,.18);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;color:#2c4a46}
.word:hover{background:rgba(70,135,129,.16)}.word:focus-visible{outline:2px solid #468781}
.word .en{font-weight:600}.word .zh{color:#3d7a72}
@media(prefers-color-scheme:dark){.translation{color:#b5ccc7;background:rgba(120,190,180,.08);border-left-color:rgba(120,190,180,.45)}.word{background:rgba(120,190,180,.12);border-color:rgba(120,190,180,.22);color:#dce9e6}.word .zh{color:#9fd3c8}}`

const cellLike=(element:HTMLElement):boolean=>/^(?:TD|TH)$/.test(element.tagName)||getComputedStyle(element).display.startsWith('table')
const placed=(element:HTMLElement,host:HTMLElement):boolean=>cellLike(element)?host.parentElement===element:element.nextElementSibling===host

export function startBrowserReading(): { clear: () => void; allowed: (value: boolean) => void } {
  let config: Config = {allowed:false,state:null,url:''}, enabled=false, ready=false, sequence=0, generation=0, pending=0, busy=false
  let paragraphs: Paragraph[] = [], observer: IntersectionObserver | null = null, mutation: MutationObserver | null = null
  const ids=new WeakMap<HTMLElement,string>(), hosts=new WeakMap<HTMLElement,HTMLElement>(), results=new Map<string,ReadingResult>(), nearby=new Set<Element>(), failures=new Set<string>()
  let stylesheet: HTMLStyleElement | null = null
  const identity = ():string => canonicalUrl(location.href)
  const active = ():boolean => enabled && config.allowed && !!config.state && config.url===identity() && (config.state.mode!=='original'||config.state.annotations)
  const ui=(node:Node):boolean => {
    const el=node.nodeType===1?node as Element:node.parentElement
    return !!el?.closest('[data-jiwei-ui]')
  }
  const style=():void=>{
    if(stylesheet?.isConnected)return
    stylesheet=document.createElement('style'); stylesheet.dataset.jiweiUi='reading-style'
    stylesheet.textContent=`
      :is(p,li,blockquote,h1,h2,h3,h4,h5,h6,td,figcaption):has(+ jiwei-reading[data-mode="translation"]) {display:none !important}
      jiwei-reading[data-jiwei-ui] {display:block!important;flex:1 0 100%!important;grid-column:1/-1!important;box-sizing:border-box!important;min-width:0!important;max-width:100%!important;overflow-wrap:anywhere!important;word-break:normal!important;position:relative!important}
      jiwei-reading[data-empty="true"] {height:0!important;margin:0!important;padding:0!important}
      ::highlight(jiwei-vocabulary) {text-decoration:underline dotted #468781;text-underline-offset:3px}
    `
    ;(document.head||document.documentElement).appendChild(stylesheet)
  }
  const isVisible=(element:Element):boolean=>{
    if(element.closest('[hidden],[aria-hidden="true"]'))return false
    for(let parent:Element|null=element;parent;parent=parent.parentElement) {
      const css=getComputedStyle(parent)
      if(css.visibility==='hidden'||css.visibility==='collapse'||Number(css.opacity)===0)return false
      if(css.display==='none' && !(parent===element && element.nextElementSibling?.matches('jiwei-reading[data-jiwei-ui][data-mode="translation"]')))return false
    }
    const host=hosts.get(element as HTMLElement),rect=(host?.isConnected?host:element).getBoundingClientRect()
    return rect.width>1 && (rect.height>0 || !!host?.isConnected)
  }
  const clear=():void=>{
    generation++; if(pending)clearTimeout(pending); pending=0; observer?.disconnect(); observer=null; nearby.clear()
    document.querySelectorAll('jiwei-reading[data-jiwei-ui]').forEach((host)=>host.remove())
    stylesheet?.remove(); stylesheet=null
    const highlights=(CSS as unknown as {highlights?:Map<string,unknown>}).highlights
    highlights?.delete('jiwei-vocabulary')
  }
  const ranges=(element:HTMLElement,word:string):Range[]=>{
    const matches:Range[]=[], walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT,{acceptNode:(node)=>ui(node)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT})
    const pattern=new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'gi')
    for(let node=walker.nextNode();node;node=walker.nextNode()) {
      for(const match of (node.textContent??'').matchAll(pattern)) {
        const range=document.createRange(); range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length); matches.push(range)
      }
    }
    return matches
  }
  const paint=():void=>{
    if(!active())return
    style()
    const highlights:Range[]=[]
    const elements=new Set(paragraphs.map((paragraph)=>paragraph.element))
    for(const element of elements) {
      const own=paragraphs.filter((paragraph)=>paragraph.element===element), outputs=own.map((p)=>results.get(p.key)), hasTranslation=outputs.some((r)=>!!r?.translation), hasWords=config.state?.annotations&&outputs.some((r)=>r?.annotations.length)
      if(!hasTranslation&&!hasWords)continue
      let host=hosts.get(element)
      if(!host?.isConnected) {
        host=document.createElement('jiwei-reading');host.dataset.jiweiUi='reading';hosts.set(element,host)
        shadowRoots.set(host,host.attachShadow({mode:'closed'}))
        // 表格单元格后面插块元素会变成一个挤窄的新单元格（维基提示框实测成竖排），所以放进单元格内部。
        if(cellLike(element))element.appendChild(host);else element.insertAdjacentElement('afterend',host)
      }
      const signature=JSON.stringify([config.state?.mode,config.state?.annotations,outputs])
      if(host.dataset.signature===signature) {
        if(config.state?.annotations&&host.dataset.mode!=='translation')for(const output of outputs)for(const annotation of output?.annotations ?? [])highlights.push(...ranges(element,annotation.word))
        continue
      }
      host.dataset.signature=signature
      host.dataset.mode=hasTranslation?config.state?.mode ?? 'original':'original'
      host.dataset.empty=String(!(hasTranslation&&config.state?.mode!=='original')&&!hasWords)
      // closed shadow root 的引用只保存在隔离世界 WeakMap 中，网站不能读写按钮行为。
      const shadow=shadowRoots.get(host) ?? hostShadow(host)
      shadow.replaceChildren()
      const css=document.createElement('style');css.textContent=READING_CSS
      shadow.appendChild(css)
      const glossed:{word:string;gloss:string;sentence:string}[]=[]
      for(let index=0;index<own.length;index++) {
        const output=outputs[index]
        if(!output)continue
        if(config.state?.mode!=='original' && output.translation) {
          const translation=document.createElement('div');translation.className='translation';translation.textContent=output.translation;translation.tabIndex=0
          const toggle=():void=>{host!.dataset.mode=host!.dataset.mode==='translation'?'parallel':config.state?.mode ?? 'parallel';schedule()}
          translation.addEventListener('click',(event)=>{if(event.isTrusted&&!window.getSelection()?.toString())toggle()});translation.addEventListener('keydown',(event)=>{if(event.isTrusted&&event.key==='Enter')toggle()});shadow.appendChild(translation)
        }
        if(config.state?.annotations) for(const annotation of output.annotations) {
          if(!ranges(element,annotation.word).length||glossed.some((g)=>g.word.toLowerCase()===annotation.word.toLowerCase()))continue
          if(host.dataset.mode!=='translation')highlights.push(...ranges(element,annotation.word))
          glossed.push({word:annotation.word,gloss:annotation.gloss,sentence:own[index].text})
        }
      }
      // 生词条：放在段落下方的独立一行，不叠在正文上，不改网页原有排版。
      if(glossed.length) {
        const strip=document.createElement('div');strip.className='words'
        for(const item of glossed) {
          const chip=document.createElement('button');chip.className='word';chip.title=`${item.word} · ${item.gloss}`
          const en=document.createElement('span');en.className='en';en.textContent=item.word
          const zh=document.createElement('span');zh.className='zh';zh.textContent=item.gloss
          chip.append(en,zh)
          chip.addEventListener('mousedown',(event)=>event.preventDefault());chip.addEventListener('click',(event)=>{
            if(event.isTrusted&&active())ipcRenderer.send('jw-page:reading-word',{url:identity(),word:item.word,gloss:item.gloss,sentence:item.sentence,language:config.state?.language ?? 'en'})
          });strip.appendChild(chip)
        }
        shadow.appendChild(strip)
      }
      host.setAttribute('data-gloss-buttons',JSON.stringify([...shadow.querySelectorAll<HTMLButtonElement>('button')].map((button)=>{const rect=button.getBoundingClientRect();return {word:button.title.split(' · ')[0],x:rect.left+rect.width/2,y:rect.top+rect.height/2}})))
    }
    const registry=(CSS as unknown as {highlights?:Map<string,unknown>}).highlights
    if(registry && typeof Highlight!=='undefined')registry.set('jiwei-vocabulary',new Highlight(...highlights))
  }
  const shadowRoots=new WeakMap<HTMLElement,ShadowRoot>()
  const hostShadow=(host:HTMLElement):ShadowRoot=>{
    // 创建时即保存；closed root 从不挂到网页全局对象。
    const root=host.attachShadow({mode:'closed'});shadowRoots.set(host,root);return root
  }
  const visibleParagraphs=():Paragraph[]=>paragraphs.filter((p)=>{
    const host=hosts.get(p.element), rect=(host?.isConnected?host:p.element).getBoundingClientRect()
    return nearby.has(p.element) || (!!host && nearby.has(host)) || (rect.bottom>=-innerHeight*2 && rect.top<=innerHeight*3)
  })
  const request=async():Promise<void>=>{
    if(!active()||busy)return
    const current=generation,mode=config.state!.mode,annotations=config.state!.annotations
    const candidates=visibleParagraphs().filter((paragraph)=>!results.has(paragraph.key)&&!failures.has(paragraph.key))
    if(!candidates.length)return
    busy=true
    try {
      for(const batch of readingBatches(candidates)) {
        if(!active()||current!==generation)return
        const result=await ipcRenderer.invoke('jw-page:reading-batch',{url:identity(),paragraphs:batch.map((p)=>({id:p.id,text:p.text})),translation:mode!=='original',annotations,targetLanguage:uiLanguage}) as ReadingBatchResult
        if(!active()||current!==generation)return
        for(const output of result.paragraphs) {
          const paragraph=batch.find((p)=>p.id===output.id)
          if(paragraph)results.set(paragraph.key,output)
        }
        paint()
      }
    } catch(error) {
      if(current===generation) {
        candidates.forEach((paragraph)=>failures.add(paragraph.key))
        // 一个失败停止本轮，不在滚动中自动反复产生费用。切换模式/重试会清除失败集合。
        ipcRenderer.send('jw-page:reading-error',{url:identity(),message:error instanceof Error?error.message.slice(0,500):'Reading request failed'})
      }
    } finally {busy=false;if(current!==generation&&active())schedule()}
  }
  let uiLanguage='zh-CN'
  const scan=():void=>{
    if(!ready||!enabled||!config.allowed)return
    for(const element of new Set(paragraphs.map((paragraph)=>paragraph.element))) {
      const host=hosts.get(element)
      if(host?.isConnected&&(!element.isConnected||!placed(element,host)))host.remove()
    }
    if(active())splitBreakParagraphs(document)
    const elements=readingParagraphs(document,isVisible), sample=elements.map((element)=>originalReadingText(element)).join('\n').slice(0,16000)
    paragraphs=elements.flatMap((element)=>{
      let id=ids.get(element);if(!id){id=`p${++sequence}`;ids.set(element,id)}
      return readingParts(originalReadingText(element)).map((text,part)=>({element,id:`${id}:${part}`,text,key:`${modeKey()}:${normalizedReadingText(text)}`,part}))
    })
    ipcRenderer.send('jw-page:reading-ready',{url:identity(),language:document.documentElement.lang,sample,characters:paragraphs.reduce((sum,p)=>sum+p.text.length,0),paragraphs:paragraphs.length})
    if(active()) {
      observer?.disconnect()
      observer=new IntersectionObserver((entries)=>{for(const entry of entries){if(entry.isIntersecting)nearby.add(entry.target);else nearby.delete(entry.target)}void request()},{rootMargin:`${innerHeight*2}px 0px ${innerHeight*2}px 0px`})
      for(const element of elements){observer.observe(element);const host=hosts.get(element);if(host?.isConnected)observer.observe(host)}
      paint();void request()
    }
  }
  const modeKey=():string=>`${config.state?.mode==='original'?'gloss':'translation'}:${config.state?.annotations}:${config.state?.revision ?? 0}`
  const schedule=():void=>{
    if(pending)return
    pending=window.setTimeout(()=>{pending=0;scan()},350)
  }
  ipcRenderer.on('jw-page:reading-config',(_event,value:Config & {uiLanguage?:string})=>{
    const same=config.url===value.url&&config.state?.mode===value.state?.mode&&config.state?.annotations===value.state?.annotations&&config.state?.revision===value.state?.revision
    if(value.uiLanguage)uiLanguage=value.uiLanguage
    if(!same){clear();failures.clear()}
    config=value
    if(!config.allowed){clear();results.clear();paragraphs=[];return}
    schedule()
  })
  const start=():void=>{
    ready=true
    mutation=new MutationObserver((records)=>{
      const removedHost=active()&&records.some((record)=>record.type==='childList'&&[...record.removedNodes].some((node)=>paragraphs.some((paragraph)=>paragraph.element.isConnected&&hosts.get(paragraph.element)===node&&!node.isConnected)))
      if(removedHost)schedule()
      if(records.every((record)=>ui(record.target) || (record.type==='childList' && [...record.addedNodes,...record.removedNodes].every(ui))))return
      if(config.url&&config.url!==identity()){clear();results.clear();paragraphs=[];config={allowed:enabled,state:null,url:identity()}}
      schedule()
    })
    mutation.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden','lang']})
    window.addEventListener('scroll',()=>{paint();void request()},{passive:true})
    document.addEventListener('click',(event)=>{
      if(!event.isTrusted||!active()||!config.state?.annotations||window.getSelection()?.toString())return
      const target=event.target instanceof Element?event.target:null
      if(!target||ui(target)||target.closest('a'))return
      for(const paragraph of paragraphs.filter((paragraph)=>paragraph.element.contains(target))) {
        if(hosts.get(paragraph.element)?.dataset.mode==='translation')continue
        for(const annotation of results.get(paragraph.key)?.annotations??[]) {
          const hit=ranges(paragraph.element,annotation.word).some((range)=>[...range.getClientRects()].some((rect)=>event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom))
          if(hit){ipcRenderer.send('jw-page:reading-word',{url:identity(),word:annotation.word,gloss:annotation.gloss,sentence:paragraph.text,language:config.state.language});return}
        }
      }
    })
    window.addEventListener('resize',()=>{for(const element of new Set(paragraphs.map((p)=>p.element)))hosts.get(element)?.removeAttribute('data-signature');schedule()})
    schedule()
  }
  if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',start,{once:true});else start()
  return {clear,allowed:(value)=>{enabled=value;if(!value){clear();results.clear();paragraphs=[]}else schedule()}}
}
