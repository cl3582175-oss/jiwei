import { createServer, type Server } from 'http'
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { _electron as electron, expect } from '@playwright/test'
import { startLensApp, type LensApp } from './lensApp'
import { startReadingSite, READING_SENTENCE } from './readingPage'
import { makePdf } from './makePdf'
import type { ReadingBatch, ReadingBatchResult, ReadingTarget } from '../../src/shared/reading'
export interface ReadingRequest { paragraphs:{id:string;text:string;translate:boolean;candidates:string[]}[];translation:boolean;prompt:string }
export interface ReadingApp extends LensApp {site:Server;base:string;readingProvider:Server;readingRequests:ReadingRequest[];readingState:{blocked:boolean;release:(()=>void)|null;fail:boolean};}
export async function startReadingApp(options:{provider?:boolean;importProviders?:string}={}):Promise<ReadingApp> {
  const env=await startLensApp({provider:false,importProviders:options.importProviders}),site=await startReadingSite(),requests:ReadingRequest[]=[],state={blocked:false,release:null as (()=>void)|null,fail:false}
  await env.app.evaluate(({app,ipcMain})=>{
    const data:unknown[]=[];(globalThis as typeof globalThis & {readingDiagnostics?:unknown[]}).readingDiagnostics=data
    ipcMain.on('jw-page:password',(event)=>data.push({event:'password',url:event.sender.getURL()}))
    app.on('web-contents-created',(_event,wc)=>{
      wc.on('did-start-navigation',(_event,url,inPlace,isMain)=>data.push({event:'start-navigation',url,inPlace,isMain}))
      wc.on('did-navigate',(_event,url)=>data.push({event:'navigate',url}))
      wc.on('did-navigate-in-page',(_event,url,isMain)=>data.push({event:'in-page',url,isMain}))
      wc.on('console-message',(_event,level,message)=>{if(level>=2)data.push({event:'console',message})})
    })
  })
  const provider=createServer((request,response)=>{
    let body=''
    request.on('data',(chunk:Buffer)=>body+=chunk.toString())
    request.on('end',()=>void(async()=>{
      try{
        const input=JSON.parse(body) as {messages:{role:string;content:string|null}[];stream?:boolean;tools?:{function:{name:string}}[]}
        const prompt=input.messages.map((message)=>message.content ?? '').join('\n'),user=input.messages.filter((message)=>message.role==='user').map((message)=>message.content ?? '').join('\n'),data=/<reading_data>\s*([\s\S]*?)\s*<\/reading_data>/.exec(user),submit=input.tools?.some((tool)=>tool.function.name==='submit')
        const paragraphs=data?JSON.parse(data[1]) as ReadingRequest['paragraphs']:[],translation=prompt.includes('translation=true')
        if(data)requests.push({paragraphs,translation,prompt})
        if(state.blocked)await new Promise<void>((resolve)=>state.release=resolve)
        if(state.fail){response.writeHead(503).end('Controlled reading failure');return}
        const output={paragraphs:paragraphs.map((paragraph)=>({id:paragraph.id,translation:(paragraph.translate??translation)?`受控译文（terminology）：${paragraph.text.slice(0,80)}`:'',annotations:paragraph.candidates.slice(0,6).map((word)=>({word,gloss:'上下文释义'}))}))}
        const text='原句中的主语是 Epistemology，谓语是 clarifies，宾语是 the methodology。of a heuristic paradigm 修饰 methodology，说明方法的所属范围。'
        if(input.stream){
          response.writeHead(200,{'content-type':'text/event-stream'});response.write(`data: ${JSON.stringify({id:'reading-chat',object:'chat.completion.chunk',model:'reading-transport-fixture',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})}\n\n`);response.write(`data: ${JSON.stringify({id:'reading-chat',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:80,total_tokens:180}})}\n\n`);response.end('data: [DONE]\n\n');return
        }
        response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:`reading-${requests.length}`,object:'chat.completion',created:1,model:'reading-transport-fixture',choices:[{index:0,message:submit?{role:'assistant',content:null,tool_calls:[{id:`submit-${requests.length}`,type:'function',function:{name:'submit',arguments:JSON.stringify(output)}}]}:{role:'assistant',content:data?JSON.stringify(output):text},finish_reason:submit?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}))
      }catch{response.writeHead(400).end('Invalid controlled request')}
    })())
  })
  await new Promise<void>((resolve)=>provider.listen(0,'127.0.0.1',resolve))
  if(options.provider!==false){
    const url=`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`
    await env.page.evaluate(async(url)=>{
      const provider=await window.jiwei.providers.save({kind:'ollama',name:'Reading transport fixture',baseUrl:url,models:['reading-transport-fixture'],modelCaps:{'reading-transport-fixture':{tier:'basic',vision:false}}}),settings=await window.jiwei.settings.get()
      await window.jiwei.settings.set({ai:{...settings.ai,chat:{providerId:provider.id,model:'reading-transport-fixture'},embedding:{mode:'cloud',providerId:null,model:null},effort:'off'},browser:{...settings.browser,proactivity:'quiet'}})
    },url)
  }
  const readingEnv:ReadingApp={...env,site:site.server,base:site.base,readingProvider:provider,readingRequests:requests,readingState:state,close:async()=>{state.release?.();env.state.release?.();await readingEnv.app.close();await new Promise<void>((resolve)=>env.provider.close(()=>resolve()));await new Promise<void>((resolve)=>provider.close(()=>resolve()));await new Promise<void>((resolve)=>site.server.close(()=>resolve()))}}
  return readingEnv
}
export async function restartReadingApp(env:ReadingApp):Promise<void> {
  const appData=await env.app.evaluate(({app})=>app.getPath('appData'))
  await env.app.close()
  env.app=await electron.launch({args:['.',`--user-data-dir=${env.userData}`],env:{...process.env,JIWEI_LANG:'zh-CN',JIWEI_SKIP_ONBOARDING:'1'}})
  env.page=await env.app.firstWindow();await env.page.waitForSelector('nav');await env.app.evaluate(({app},path)=>app.setPath('appData',path),appData)
  const size=process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if(size?.length===2)await env.app.evaluate(({BrowserWindow},[w,h])=>BrowserWindow.getAllWindows()[0].setSize(w,h),size)
}
/** 真实导入路径，等待解析后的分段，绝不插入伪造的 source_segments。 */
export async function seedReadingSource(env:ReadingApp,kind:'text'|'pdf'|'html'|'epub'='text',text=READING_SENTENCE):Promise<string> {
  const dir=join(env.userData,'reading-fixtures');mkdirSync(dir,{recursive:true})
  const path=join(dir,`reading-${randomUUID()}.${kind==='text'?'txt':kind}`)
  let bytes:string|Buffer=text
  if(kind==='pdf')bytes=makePdf(Array.from({length:6},(_,i)=>[`Reading research page ${i+1}`,text,'Terminology supports contextual academic interpretation.']))
  if(kind==='epub') {
    const JSZip=(await import('jszip')).default,zip=new JSZip()
    zip.file('mimetype','application/epub+zip');zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>')
    zip.file('OEBPS/book.opf','<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:language>fr</dc:language></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>')
    zip.file('OEBPS/chapter.xhtml',`<html lang="fr"><head><title>Recherche</title></head><body><p>${text}</p></body></html>`)
    bytes=await zip.generateAsync({type:'nodebuffer'})
  }
  writeFileSync(path,bytes)
  const result=await env.page.evaluate((path)=>window.jiwei.sources.importPaths([path]),path),source=result.imported[0]
  if(!source)throw new Error('Reading fixture did not import a source')
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.segments.list(id).then((s)=>s.length),source.id),{timeout:30000}).toBeGreaterThan(0)
  return source.id
}
export async function browserReadingTarget(env:ReadingApp,url=`${env.base}/article`):Promise<ReadingTarget> {
  if(!await env.page.getByTestId('browser-pane').count()) {
    if(!await env.page.getByRole('button',{name:'在笔记旁打开浏览器'}).count()) {
      await env.page.keyboard.press('ControlOrMeta+n')
      await env.page.getByPlaceholder('笔记标题').fill('阅读验证')
      await env.page.keyboard.press('Enter')
    }
    await env.page.getByRole('button',{name:'在笔记旁打开浏览器'}).click()
    await expect(env.page.getByTestId('browser-pane')).toBeVisible()
  }
  const id=await env.page.evaluate((url)=>window.jiwei.browser.open(url,{newTab:true}),url)
  // renderer 入口保证原生视图有真实栏宽/视口，IntersectionObserver 才有产品意义。
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.browser.state().then((state)=>state.tabs.find((tab)=>tab.id===id)?.loading),id)).toBe(false)
  return {kind:'browser',id}
}
export async function sourceReadingBatch(env:ReadingApp,id:string,annotations=true):Promise<ReadingBatchResult> {
  const segments=await env.page.evaluate((id)=>window.jiwei.segments.list(id),id),target:ReadingTarget={kind:'source',id}
  const input:ReadingBatch={target,paragraphs:[{id:`${segments[0].id}:0`,text:segments[0].text.slice(0,2400)}],translation:true,annotations,targetLanguage:'zh-CN'}
  return env.page.evaluate((input)=>window.jiwei.reading.translate(input),input)
}
export async function readingPageEval<T>(env:ReadingApp,code:string,tabId?:string):Promise<T> {
  const target=tabId?await env.page.evaluate((id)=>window.jiwei.browser.state().then((state)=>state.tabs.find((tab)=>tab.id===id)?.url),tabId):undefined
  return env.app.evaluate(async({webContents},{code,target})=>{
    const wc=webContents.getAllWebContents().find((wc)=>target?wc.getURL()===target:wc.getURL().startsWith('http://127.0.0.1')&&wc.getURL().includes('/article'))
    if(!wc)throw new Error('Reading page not found')
    return wc.executeJavaScript(code)
  },{code,target}) as Promise<T>
}
export async function clickReadingPage(env:ReadingApp,x:number,y:number):Promise<void> {
  await env.app.evaluate(({webContents},{x,y})=>{const wc=webContents.getAllWebContents().find((wc)=>wc.getURL().startsWith('http://127.0.0.1')&&wc.getURL().includes('/article'))!,zoom=wc.getZoomFactor();wc.sendInputEvent({type:'mouseDown',x:Math.round(x*zoom),y:Math.round(y*zoom),button:'left',clickCount:1});wc.sendInputEvent({type:'mouseUp',x:Math.round(x*zoom),y:Math.round(y*zoom),button:'left',clickCount:1})},{x,y})
}
