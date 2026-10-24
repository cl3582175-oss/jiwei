import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { startReadingApp, restartReadingApp, browserReadingTarget, readingPageEval, clickReadingPage, seedReadingSource, sourceReadingBatch, type ReadingApp } from './fixtures/readingApp'
import { ESSAY, READING_SENTENCE } from './fixtures/readingPage'
import { pageAction } from './fixtures/browserPage'
import type { ReadingTarget } from '../src/shared/reading'
import { DOC_FIELD, type DocJSON } from '../src/shared/types'
import { navTo } from './fixtures/nav'
test.describe.configure({mode:'serial'})
test.setTimeout(90000)
let env:ReadingApp,target:ReadingTarget,pdfId='',glossaryId='',addedWord='',recognizedWord=''
test.beforeAll(async()=>{env=await startReadingApp();target=await browserReadingTarget(env)})
test.afterAll(async()=>{
  if(env){const dir='.superpowers/sdd/2026-10-10-mistakes-and-reading/evidence';mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${process.env.READING_EVIDENCE_NAME??`reading-controlled-${process.env.JIWEI_TEST_WINDOW??'wide'}`}-requests.json`),JSON.stringify({requests:env.readingRequests,profile:await env.page.evaluate(()=>window.jiwei.reading.profile())},null,2));await env.close()}
})
const control=()=>env.page.getByTestId('reading-control').first()
async function mode(name:'原文'|'对照'|'译文'):Promise<void>{await control().click();await env.page.getByRole('menuitem',{name,exact:true}).click()}
async function shot(name:string,sample:ReadingApp=env,reopenWord?:()=>Promise<void>,beforeShot?:()=>Promise<void>):Promise<void>{
  if(!process.env.SHOTS_DIR)return
  const dir=resolve(process.env.SHOTS_DIR);mkdirSync(dir,{recursive:true})
  const themeTo=async(theme:'light'|'dark'):Promise<void>=>{
    if(await sample.page.evaluate(()=>document.documentElement.dataset.theme)===theme)return
    const wordOpen=await sample.page.getByTestId('reading-word-card').isVisible()
    if(wordOpen){
      if(!reopenWord)throw new Error('Theme capture requires the real word-card reopening action')
      await sample.page.keyboard.press('Escape');await expect(sample.page.getByTestId('reading-word-card')).not.toBeVisible()
    }
    await sample.page.getByRole('button',{name:/^设置/}).click()
    const settings=sample.page.getByRole('dialog',{name:'设置',exact:true})
    await settings.getByRole('tab',{name:'外观',exact:true}).click()
    await settings.getByRole('radio',{name:theme==='dark'?'深色':'浅色',exact:true}).click()
    await expect.poll(()=>sample.page.evaluate(()=>document.documentElement.dataset.theme)).toBe(theme)
    // Clicking the close control preserves a non-modal grammar AnswerCard, whose Escape handler would close it too.
    await settings.locator('button').last().click();await expect(settings).not.toBeVisible()
    if(wordOpen)await reopenWord!()
  }
  for(const theme of ['light','dark'] as const){
    await themeTo(theme)
    await beforeShot?.()
    await expect.poll(()=>sample.page.evaluate(()=>document.getAnimations().filter((animation)=>animation.playState==='running'&&animation.effect?.getTiming().iterations!==Infinity).length)).toBe(0)
    const filename=name.replace(/-light\.png$/,`-${theme}.png`)
    await sample.page.screenshot({path:join(dir,filename)})
    if(await sample.page.getByTestId('browser-pane').count())await sample.app.evaluate(async({webContents},{base,path})=>{
      const wc=webContents.getAllWebContents().find((wc)=>wc.getURL().startsWith(`${base}/article`))
      if(wc)process.getBuiltinModule('fs').writeFileSync(path,(await wc.capturePage()).toPNG())
    },{base:sample.base,path:join(dir,filename.replace('.png','-browser.png'))})
  }
  await themeTo('light')
}
async function noteJSON(noteId:string):Promise<DocJSON>{
  const bytes=await env.page.evaluate(async(id)=>Array.from(await window.jiwei.notes.loadDoc(id)),noteId),doc=new Y.Doc()
  try{Y.applyUpdate(doc,new Uint8Array(bytes));return yDocToProsemirrorJSON(doc,DOC_FIELD) as DocJSON}finally{doc.destroy()}
}
async function openSource(id:string):Promise<void>{
  await navTo(env.page,/^资料库/)
  const source=await env.page.evaluate((id)=>window.jiwei.sources.get(id),id)
  await env.page.getByPlaceholder('搜索资料').fill(source!.title)
  await env.page.getByText(source!.title,{exact:true}).dblclick()
}

test('外文入口、首次费用和水平选择 → 视口批次、动态补插与跟踪网址',async()=>{
  await expect(control()).toBeVisible()
  expect(env.readingRequests.length).toBe(0)
  const width=await readingPageEval<number>(env,'document.documentElement.scrollWidth')
  await mode('对照')
  const dialog=env.page.getByRole('dialog',{name:'开启对照阅读'})
  await expect(dialog).toBeVisible();await expect(dialog).toContainText('只翻你读到的部分')
  await dialog.getByRole('radio',{name:/四级/}).click()
  await dialog.getByLabel('以后不再提示费用').check()
  await dialog.getByRole('button',{name:'开始阅读',exact:true}).click()
  try {await expect.poll(()=>readingPageEval<number>(env,'document.querySelectorAll("jiwei-reading[data-jiwei-ui]").length'),{timeout:30000}).toBeGreaterThan(2)}
  catch(error){console.log(JSON.stringify({mode:'controlled-first-diagnostics',state:await env.page.evaluate((target)=>window.jiwei.reading.state(target),target),tabs:await env.page.evaluate(()=>window.jiwei.browser.state()),requests:env.readingRequests.length,events:await env.app.evaluate(()=>((globalThis as typeof globalThis & {readingDiagnostics?:unknown[]}).readingDiagnostics)),page:await readingPageEval(env,'({ready:document.readyState,paragraphs:document.querySelectorAll("p").length,ui:document.querySelectorAll("[data-jiwei-ui]").length,viewport:{width:innerWidth,height:innerHeight},first:{display:getComputedStyle(document.querySelector("#first")).display,rect:document.querySelector("#first").getBoundingClientRect().toJSON()}})')}));throw error}
  expect(env.readingRequests.length).toBeGreaterThan(0)
  expect(env.readingRequests.flatMap((request)=>request.paragraphs).length).toBeLessThan(35)
  expect(env.readingRequests.every((request)=>request.paragraphs.length<=20&&request.paragraphs.reduce((sum,p)=>sum+p.text.length,0)<=3000)).toBe(true)
  const sent=env.readingRequests.flatMap((request)=>request.paragraphs.map((p)=>p.text)).join('\n')
  expect(sent).not.toContain('HIDDEN LOGIN TEXT');expect(sent).not.toContain('hiddenCode');expect(sent).not.toContain('Navigation pseudoscience');expect(sent).not.toContain('FORMULA SHOULD NOT TRANSLATE')
  await expect.poll(()=>readingPageEval<boolean>(env,'!!document.querySelector("#delayed + jiwei-reading")')).toBe(true)
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.browser.state().then((s)=>s.tabs.find((tab)=>tab.id===id)?.url),target.id)).toContain('utm_source=dynamic')
  await expect.poll(()=>readingPageEval<number>(env,'document.documentElement.scrollWidth')).toBeLessThanOrEqual(width+2)
  await shot('reading-parallel-light.png')
})
test('React 替换原段落后译文补插；模式切换不会改原节点',async()=>{
  const original=await readingPageEval<string>(env,'document.querySelector("#rerender").outerHTML')
  await readingPageEval(env,'(() => {const p=document.querySelector("#rerender"),n=p.cloneNode(true),host=p.nextElementSibling;if(host?.tagName!=="JIWEI-READING")throw new Error("Translated original fixture missing");host.dataset.readingReplaced="true";p.replaceWith(n)})()')
  await expect.poll(()=>readingPageEval<boolean>(env,'!!document.querySelector("#rerender + jiwei-reading")')).toBe(true)
  await expect.poll(()=>readingPageEval<number>(env,'document.querySelectorAll("jiwei-reading[data-reading-replaced]").length')).toBe(0)
  expect(await readingPageEval<number>(env,'document.querySelectorAll("#rerender + jiwei-reading + jiwei-reading").length')).toBe(0)
  expect(await readingPageEval<string>(env,'document.querySelector("#rerender").outerHTML')).toBe(original)
  const requests=env.readingRequests.length
  await readingPageEval(env,'document.querySelector("#first + jiwei-reading").remove()')
  await expect.poll(()=>readingPageEval<boolean>(env,'!!document.querySelector("#first + jiwei-reading")')).toBe(true)
  expect(env.readingRequests.length).toBe(requests)
  await mode('译文')
  await expect.poll(()=>readingPageEval<string>(env,'getComputedStyle(document.querySelector("#first")).display')).toBe('none')
  await shot('reading-translation-light.png')
  await mode('原文')
  await expect.poll(()=>readingPageEval<number>(env,'document.querySelectorAll("jiwei-reading[data-jiwei-ui]").length')).toBe(0)
  await shot('reading-original-light.png')
  await mode('对照')
  await expect.poll(()=>readingPageEval<boolean>(env,'!!document.querySelector("#first + jiwei-reading")')).toBe(true)
})
test('存为资料、AI 读页及选区批注的 quote/prefix/suffix 都没有译文',async()=>{
  const sourceId=await env.page.evaluate((id)=>window.jiwei.browser.saveSource(id),target.id)
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.segments.list(id).then((segs)=>segs.map((s)=>s.text).join('\n')),sourceId),{timeout:30000}).toContain(READING_SENTENCE)
  const saved=await env.page.evaluate((id)=>window.jiwei.segments.list(id).then((segs)=>segs.map((s)=>s.text).join('\n')),sourceId)
  expect(saved).not.toContain('受控译文');expect(saved).not.toContain('上下文释义')
  await readingPageEval(env,'(() => {const range=document.createRange();range.setStartBefore(document.querySelector("#first"));range.setEndAfter(document.querySelector("#rerender"));const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()')
  const page=await env.page.evaluate((id)=>window.jiwei.browser.readPage(id),target.id)
  await mode('译文')
  const cost=env.page.getByRole('dialog',{name:'开启对照阅读'});if(await cost.isVisible())await cost.getByRole('button',{name:'开始阅读',exact:true}).click()
  await expect.poll(()=>readingPageEval<string>(env,'document.querySelector("#first + jiwei-reading")?.getAttribute("data-mode")'),{timeout:30000}).toBe('translation')
  const translationPage=await env.page.evaluate((id)=>window.jiwei.browser.readPage(id),target.id)
  const evidenceDir='.superpowers/sdd/2026-10-10-mistakes-and-reading/evidence';mkdirSync(evidenceDir,{recursive:true});writeFileSync(join(evidenceDir,`${process.env.READING_EVIDENCE_NAME??'reading-controlled'}-read-page.json`),JSON.stringify({saved,page,translationPage},null,2))
  expect(page.text).toContain(READING_SENTENCE);expect(page.text).not.toContain('受控译文')
  expect(page.text).not.toContain('HIDDEN LOGIN TEXT')
  expect(page.selection).toContain(READING_SENTENCE);expect(page.selection).not.toMatch(/HIDDEN LOGIN TEXT|受控译文|上下文释义/)
  expect(page.text).toMatch(/Knowledge and learning\n+Epistemology/)
  expect(translationPage.text).toContain(READING_SENTENCE);expect(translationPage.text).not.toMatch(/HIDDEN LOGIN TEXT|受控译文|上下文释义/)
  expect(translationPage.text).toMatch(/Knowledge and learning\n+Epistemology/)
  await mode('对照')
  await pageAction(env.app,'Common words are left unannotated.','highlighting')
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.annotations.list('source',id).then((a)=>a.length),sourceId)).toBeGreaterThan(0)
  const annotations=await env.page.evaluate((id)=>window.jiwei.annotations.list('source',id),sourceId)
  for(const annotation of annotations)expect(JSON.stringify(annotation.selector)).not.toMatch(/受控译文|上下文释义/)
})
test('只给超纲词注释 → 词卡认识后消失 → 生词提案/Yjs/卡片',async()=>{
  const cachedRequests=env.readingRequests.length
  await control().click();await env.page.getByRole('menuitem',{name:'按水平注释',exact:true}).click()
  await expect.poll(()=>readingPageEval<number>(env,'document.querySelectorAll("jiwei-reading[data-gloss-buttons]").length')).toBeGreaterThan(0)
  await expect.poll(()=>readingPageEval<{word:string;x:number;y:number}[]>(env,'JSON.parse(document.querySelector("#first + jiwei-reading")?.getAttribute("data-gloss-buttons")||"[]")')).not.toEqual([])
  let buttons=await readingPageEval<{word:string;x:number;y:number}[]>(env,'JSON.parse(document.querySelector("#first + jiwei-reading").getAttribute("data-gloss-buttons"))')
  expect(buttons.length).toBeLessThanOrEqual(6);expect(buttons.some((b)=>b.word==='Common')).toBe(false)
  const cachedParagraph=env.readingRequests.slice(cachedRequests).flatMap((request)=>request.paragraphs).find((paragraph)=>paragraph.text.includes(READING_SENTENCE))
  expect(cachedParagraph?.translate).toBe(false)
  const recognize=buttons[0];recognizedWord=recognize.word
  const wordRect=await readingPageEval<{x:number;y:number}>(env,`(() => {const word=${JSON.stringify(recognize.word)},walk=document.createTreeWalker(document.querySelector('#first'),NodeFilter.SHOW_TEXT);for(let node=walk.nextNode();node;node=walk.nextNode()){const at=node.data.toLowerCase().indexOf(word.toLowerCase());if(at>=0){const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+word.length);const rect=range.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}}}throw new Error('Annotated original word missing')})()`)
  await clickReadingPage(env,wordRect.x,wordRect.y)
  await expect(env.page.getByTestId('reading-word-card')).toBeVisible()
  await env.page.getByRole('button',{name:'认识了',exact:true}).click()
  await expect.poll(()=>readingPageEval<{word:string}[]>(env,'JSON.parse(document.querySelector("#first + jiwei-reading")?.getAttribute("data-gloss-buttons")||"[]")').then((buttons)=>buttons.length>0&&!buttons.some((b)=>b.word===recognize.word))).toBe(true)
  recognizedWord=(await env.page.evaluate(()=>window.jiwei.reading.profile())).knownWords[0]
  buttons=await readingPageEval<{word:string;x:number;y:number}[]>(env,'JSON.parse(document.querySelector("#first + jiwei-reading").getAttribute("data-gloss-buttons"))')
  const add=buttons[0];addedWord=add.word;await clickReadingPage(env,add.x,add.y)
  await expect(env.page.getByTestId('reading-word-card')).toBeVisible();await shot('reading-vocabulary-card-light.png',env,async()=>{
    const button=(await readingPageEval<{word:string;x:number;y:number}[]>(env,'JSON.parse(document.querySelector("#first + jiwei-reading").getAttribute("data-gloss-buttons"))')).find((button)=>button.word===add.word)
    if(!button)throw new Error('Annotated word missing after the real theme change')
    await clickReadingPage(env,button.x,button.y);await expect(env.page.getByTestId('reading-word-card')).toBeVisible()
  })
  await env.page.getByRole('button',{name:'加入生词本',exact:true}).click();await env.page.getByRole('button',{name:'确认写入生词本',exact:true}).click()
  await expect.poll(()=>env.page.evaluate(()=>window.jiwei.notes.list({search:'生词本 · 英语'}).then((n)=>n.length))).toBe(1)
  const note=(await env.page.evaluate(()=>window.jiwei.notes.list({search:'生词本 · 英语'})))[0];glossaryId=note.id
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.review.forNote(id).then((c)=>c.length),note.id),{timeout:10000}).toBe(1)
  await env.page.getByRole('dialog').getByRole('button',{name:'打开生词笔记'}).click()
  await expect(env.page.locator('.tiptap')).toContainText(add.word.toLowerCase())
  await shot('reading-glossary-light.png')
  expect(((await noteJSON(note.id)).content??[]).filter((node)=>node.type==='cornellRow')).toHaveLength(1)
})
test('缓存跨来源命中、注释独立批次和阈值信号持久化',async()=>{
  const source=await seedReadingSource(env,'text','An obscure heuristic explains an epistemological paradigm.'),first=await sourceReadingBatch(env,source),count=env.readingRequests.length
  const text='An obscure heuristic explains an epistemological paradigm.',other=await seedReadingSource(env,'html',`<html lang="en"><head><title>Other source</title></head><body><article><p>${text}</p></article></body></html>`),second=await sourceReadingBatch(env,other)
  expect(second.paragraphs[0].cached).toBe(true);expect(second.paragraphs[0].translation).toBe(first.paragraphs[0].translation);expect(env.readingRequests.length).toBe(count)
  const before=await env.page.evaluate(()=>window.jiwei.reading.profile()),after=await env.page.evaluate(()=>window.jiwei.reading.query('the'))
  expect(after.pendingSignals).toBe(before.pendingSignals+1)
  const originalOnly=await seedReadingSource(env,'text','An interdisciplinary heuristic resolves epistemological ambiguity.')
  await openSource(originalOnly);await env.page.getByTestId('reading-control').click();await env.page.getByRole('menuitem',{name:'按水平注释',exact:true}).click()
  await expect(env.page.getByTestId('reading-annotations').first()).toBeVisible()
  await expect(env.page.getByTestId('reading-translation')).toHaveCount(0)
  const overlap=await env.page.getByTestId('reading-source-text').evaluate((root)=>{
    const original:{text:string;rect:DOMRect}[]=[],walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT)
    for(let node=walk.nextNode();node;node=walk.nextNode()){
      if(!node.textContent?.trim()||node.parentElement?.closest('[data-jiwei-ui]'))continue
      const range=document.createRange();range.selectNodeContents(node)
      for(const rect of range.getClientRects())if(rect.width&&rect.height)original.push({text:node.textContent,rect})
    }
    return [...root.querySelectorAll<HTMLElement>('[data-testid=reading-annotations]')].flatMap((gloss)=>{
      const word=gloss.parentElement?.firstChild
      if(!word)throw new Error('Annotated original text missing')
      const range=document.createRange();range.selectNodeContents(word)
      const owner=range.getBoundingClientRect(),label=gloss.getBoundingClientRect()
      return original.filter(({rect})=>rect.bottom<=owner.top+1&&label.top<rect.bottom-.5&&label.bottom>rect.top+.5&&label.left<rect.right-.5&&label.right>rect.left+.5).map(({text})=>({word:word.textContent,gloss:gloss.textContent,previousLine:text}))
    })
  })
  expect(overlap).toEqual([])
  expect(env.readingRequests.at(-1)?.translation).toBe(false)
  expect(env.readingRequests.at(-1)?.paragraphs.some((paragraph)=>paragraph.candidates.length>0)).toBe(true)
  await shot('reading-annotations-only-light.png')
  const adjusted=await env.page.evaluate(async()=>{for(let i=0;i<50;i++)await window.jiwei.reading.query('the');return window.jiwei.reading.profile()})
  expect(adjusted.threshold).toBeGreaterThanOrEqual(before.threshold*.9);expect(adjusted.threshold).toBeLessThan(before.threshold);expect(adjusted.history.some((entry)=>entry.reason==='signals')).toBe(true)
  await env.page.evaluate(()=>window.jiwei.reading.setThreshold(4000))
  expect((await env.page.evaluate(()=>window.jiwei.reading.cacheStats())).bytes).toBeLessThanOrEqual(50*1024*1024)
})
test('讲语法沿就地答复卡片与现有技能路径',async()=>{
  target=await browserReadingTarget(env);await mode('原文')
  await pageAction(env.app,READING_SENTENCE,'grammar')
  const card=env.page.getByRole('dialog',{name:'就地答复'})
  await expect(card).toContainText('谓语',{timeout:30000});await expect(card).toContainText(READING_SENTENCE)
  await shot('reading-grammar-card-light.png')
  await card.getByRole('button',{name:'存入笔记',exact:true}).click();await expect(card).not.toBeVisible()
  await expect.poll(()=>env.page.locator('.tiptap').textContent()).toContain('谓语')
})
test('PDF 真实分段对照、中文/敏感/无痕入口与仅本地云端拒绝',async()=>{
  pdfId=await seedReadingSource(env,'pdf')
  await openSource(pdfId)
  await expect(env.page.getByTestId('pdf-viewer')).toBeVisible()
  await env.page.getByTestId('reading-control').click();await env.page.getByRole('menuitem',{name:'对照',exact:true}).click()
  await expect.poll(()=>env.page.getByTestId('reading-translation').count(),{timeout:30000}).toBeGreaterThan(0)
  await expect(env.page.getByTestId('reading-pdf-text')).toContainText('第 1 页')
  await shot('reading-pdf-parallel-light.png')
  await env.page.evaluate((id)=>window.jiwei.sources.update(id,{aiExcluded:true}),pdfId)
  await expect(env.page.getByTestId('reading-control')).toHaveCount(0)
  await expect(env.page.getByTestId('reading-translation')).toHaveCount(0)
  await expect(env.page.getByTestId('reading-pdf-text')).toHaveCount(0)
  const calls=env.readingRequests.length
  const denial=await env.page.evaluate(async(id)=>{
    const settings=await window.jiwei.settings.get(),anchor={kind:'source-text' as const,parentType:'source' as const,parentId:id,ownerId:null,quote:'Private original'}
    try{await window.jiwei.chat.send({conversationId:null,text:'解释语法',providerId:settings.ai.chat.providerId!,model:settings.ai.chat.model!,effort:'off',kind:'inline',skill:'explain-grammar',scope:{type:'all'},anchor,context:{targets:[anchor],sourceId:id,noteId:null,cursorRowId:null}});return ''}catch(e){return String(e)}
  },pdfId)
  expect(denial).toMatch(/不发送|local-only|excluded|仅本地/)
  const denied=await env.page.evaluate(async(id)=>{try{await window.jiwei.reading.translate({target:{kind:'source',id},paragraphs:[{id:'private',text:'Private text'}],translation:true,annotations:false,targetLanguage:'zh'});return ''}catch(e){return String(e)}},pdfId)
  expect(denied).toContain('仅本地')
  expect(env.readingRequests.length).toBe(calls)
})
test('敏感与中文网页不提供入口，关闭阅读后迟到输出被丢弃',async()=>{
  target=await browserReadingTarget(env)
  const chinese=await env.page.evaluate((url)=>window.jiwei.browser.open(url,{newTab:true}),`${env.base}/chinese`)
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.reading.state({kind:'browser',id}).then((s)=>s.foreign),chinese)).toBe(false)
  await expect(control()).toHaveCount(0)
  const login=await env.page.evaluate((url)=>window.jiwei.browser.open(url,{newTab:true}),`${env.base}/login`)
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.browser.state().then((state)=>state.tabs.find((t)=>t.id===id)?.sensitive),login)).toBe(true)
  await expect(control()).toHaveCount(0)
  const secret=await env.page.evaluate((url)=>window.jiwei.browser.open(url,{newTab:true,incognito:true}),`${env.base}/article`)
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.reading.state({kind:'browser',id}).then((s)=>s.foreign),secret)).toBe(false)
  await expect(control()).toHaveCount(0)
  await env.page.evaluate((id)=>window.jiwei.browser.close(id),secret)
  const source=await seedReadingSource(env,'text','An independent and unprecedented epistemological interpretation requires evidence.')
  env.readingState.blocked=true
  const promise=sourceReadingBatch(env,source).then(()=>'',(e:Error)=>e.message)
  await expect.poll(()=>!!env.readingState.release).toBe(true)
  await env.page.evaluate((id)=>window.jiwei.reading.configure({target:{kind:'source',id},mode:'original',annotations:false}),source)
  env.readingState.blocked=false;env.readingState.release?.();env.readingState.release=null
  expect(await promise).toMatch(/改变|changed|abort/i)
})
test('HTML 与 EPUB 原语言元数据禁用英语注释；敏感和仅本地资料阻止翻译/讲语法',async()=>{
  const french='La recherche epistemologique propose une methode heuristique pour comprendre les paradigmes.'
  for(const kind of ['html','epub'] as const){
    const source=await seedReadingSource(env,kind,kind==='html'?`<html lang="fr"><body><article><p>${french}</p></article></body></html>`:french)
    const state=await env.page.evaluate((id)=>window.jiwei.reading.state({kind:'source',id}),source)
    expect(state.language).toBe('fr');expect(state.foreign).toBe(true)
    await openSource(source);await env.page.getByTestId('reading-control').click();await expect(env.page.getByRole('menuitem',{name:'按水平注释',exact:true})).toHaveCount(0);await env.page.keyboard.press('Escape')
    const result=await sourceReadingBatch(env,source);expect(result.paragraphs[0].annotations).toEqual([])
    await env.page.evaluate((id)=>window.jiwei.sources.update(id,{aiExcluded:true}),source);await expect(env.page.getByTestId('reading-control')).toHaveCount(0)
    for(const skill of ['explain-grammar','translate-passage']){
      const denied=await env.page.evaluate(async({source,skill})=>{const settings=await window.jiwei.settings.get(),anchor={kind:'source-text' as const,parentType:'source' as const,parentId:source,ownerId:null,quote:'Private original'};try{await window.jiwei.chat.send({conversationId:null,text:'解释原文',providerId:settings.ai.chat.providerId!,model:settings.ai.chat.model!,effort:'off',kind:'inline',skill,scope:{type:'all'},anchor,context:{targets:[anchor],sourceId:source,noteId:null,cursorRowId:null}});return ''}catch(error){return String(error)}},{source,skill})
      expect(denied).toMatch(/不发送|local-only|excluded|仅本地/)
    }
  }
  const source=await seedReadingSource(env,'text','A private source must stay outside cloud reading requests.')
  // A previously saved sensitive source retains its provenance; the public edit API intentionally cannot change its URL.
  await env.app.evaluate(({app},id)=>{
    const path=process.getBuiltinModule('path'),req=process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(),'package.json')),Database=req('better-sqlite3') as typeof import('better-sqlite3'),db=new Database(path.join(app.getPath('userData'),'data/jiwei.db'))
    try{db.prepare('UPDATE sources SET url=? WHERE id=?').run('https://mail.google.com/mail/u/0/',id)}finally{db.close()}
  },source)
  expect((await env.page.evaluate((id)=>window.jiwei.reading.state({kind:'source',id}),source)).foreign).toBe(false)
  await expect(sourceReadingBatch(env,source)).rejects.toThrow(/敏感|privacy|unavailable/)
})
test('待确认词汇关闭网页和重启后可恢复，同一行追加例句、概念只记一次且可撤销',async()=>{
  const sentence=`A different sentence uses ${addedWord.toLowerCase()} to clarify empirical evidence.`,source=await seedReadingSource(env,'text',sentence),cardsBefore=await env.page.evaluate((id)=>window.jiwei.review.forNote(id).then((cards)=>cards.length),glossaryId)
  const landing=await env.page.evaluate(({source,word,sentence})=>window.jiwei.reading.prepare({target:{kind:'source',id:source},word,gloss:'上下文释义',sentence,language:'en',concept:true}),{source,word:addedWord,sentence})
  const pending=await env.page.evaluate((id)=>window.jiwei.proposals.list(id),glossaryId)
  expect(pending).toHaveLength(1);expect(pending[0].ops[0].op).toBe('insert_after')
  const generic=await env.page.evaluate(async(id)=>{try{await window.jiwei.proposals.resolve(id,0,'accepted',[]);return ''}catch(error){return String(error)}},landing.proposalId!)
  expect(generic).toMatch(/领域|domain|确认|专用|dedicated/)
  await env.page.evaluate((id)=>window.jiwei.browser.close(id),target.id);await restartReadingApp(env)
  await navTo(env.page,/^笔记/);await env.page.getByPlaceholder('搜索笔记').fill('生词本 · 英语');await env.page.getByRole('button',{name:/生词本 · 英语/}).first().click()
  const notice=env.page.getByTestId('learning-proposal-notice')
  await expect(notice).toContainText(sentence);await expect(notice.getByRole('button',{name:'接受',exact:true})).toHaveCount(0)
  await notice.getByRole('button',{name:'确认写入生词本',exact:true}).click();await expect(notice).toHaveCount(0)
  await expect(env.page.locator('.tiptap')).toContainText(sentence)
  const rows=((await noteJSON(glossaryId)).content??[]).filter((node)=>node.type==='cornellRow'),matching=rows.filter((node)=>(node.content?.[0]?.content?.[0]?.content?.[0]?.text ?? '').toLowerCase()===landing.word.toLowerCase())
  expect(matching).toHaveLength(1);expect(JSON.stringify(matching[0])).toContain(sentence)
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.review.forNote(id).then((cards)=>cards.length),glossaryId)).toBe(cardsBefore)
  const concept=await env.page.evaluate((word)=>window.jiwei.memory.concepts().then((concepts)=>concepts.find((concept)=>concept.name===word)),landing.word)
  expect(concept?.asked).toBe(1)
  await env.page.evaluate(async(id)=>window.jiwei.reading.complete(id,new Uint8Array()),landing.proposalId!)
  expect((await env.page.evaluate((word)=>window.jiwei.memory.concepts().then((concepts)=>concepts.find((concept)=>concept.name===word)),landing.word))?.asked).toBe(1)
  await env.page.locator('.tiptap').click();await env.page.keyboard.press('ControlOrMeta+z');await expect(env.page.locator('.tiptap')).not.toContainText(sentence)
  await expect.poll(async()=>JSON.stringify(await noteJSON(glossaryId))).not.toContain(sentence)
  await env.page.keyboard.press('ControlOrMeta+Shift+z');await expect(env.page.locator('.tiptap')).toContainText(sentence)
  await expect.poll(async()=>JSON.stringify(await noteJSON(glossaryId))).toContain(sentence)
  await env.page.reload();await env.page.waitForSelector('nav')
  await navTo(env.page,/^笔记/);await env.page.getByPlaceholder('搜索笔记').fill('生词本 · 英语');await env.page.getByRole('button',{name:/生词本 · 英语/}).first().click()
  await expect(env.page.locator('.tiptap')).toContainText(sentence)
  expect((await env.page.evaluate(()=>window.jiwei.reading.profile())).knownWords).toContain(recognizedWord.toLowerCase())
  await shot('reading-glossary-resumed-light.png')
})
test('翻译失败保持重试入口；显式重试恢复缺失段，不在滚动中重复调用',async()=>{
  target=await browserReadingTarget(env);await mode('对照')
  await expect.poll(()=>readingPageEval<boolean>(env,'!!document.querySelector("#first + jiwei-reading")')).toBe(true)
  env.readingState.fail=true
  await readingPageEval(env,'(() => {const p=document.createElement("p");p.id="retry-original";p.textContent="A distinctive counterfactual hypothesis requires reproducible epistemological verification.";document.querySelector("#first").before(p);window.scrollTo(0,0)})()')
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.browser.state().then((state)=>state.tabs.find((tab)=>tab.id===id)?.reading?.error),target.id),{timeout:30000}).toBeTruthy()
  const error=await env.page.evaluate((id)=>window.jiwei.browser.state().then((state)=>state.tabs.find((tab)=>tab.id===id)?.reading?.error),target.id),calls=env.readingRequests.length
  const refreshed=await env.page.evaluate((target)=>window.jiwei.reading.state(target),target)
  expect(refreshed.error).toBe(error)
  await control().click();await expect(env.page.getByRole('menuitem',{name:'重试',exact:true})).toBeVisible()
  expect(env.readingRequests.length).toBe(calls)
  env.readingState.fail=false
  await env.page.getByRole('menuitem',{name:'重试',exact:true}).click()
  await expect.poll(()=>readingPageEval<boolean>(env,'!!document.querySelector("#retry-original + jiwei-reading")'),{timeout:30000}).toBe(true)
  expect(env.readingRequests.length).toBeGreaterThan(calls)
  expect((await env.page.evaluate((target)=>window.jiwei.reading.state(target),target)).error).toBeUndefined()
})
test('预埋隐藏登录框不关闭阅读，显示密码框后立即清理译文和阻止后续调用',async()=>{
  target=await browserReadingTarget(env);await mode('对照')
  await expect.poll(()=>readingPageEval<number>(env,'document.querySelectorAll("jiwei-reading[data-jiwei-ui]").length')).toBeGreaterThan(2)
  expect((await env.page.evaluate((id)=>window.jiwei.browser.state().then((state)=>state.tabs.find((tab)=>tab.id===id)),target.id))?.sensitive).toBe(false)
  await readingPageEval(env,'document.querySelector("input[type=password]").parentElement.style.display="block"')
  await expect.poll(()=>env.page.evaluate((id)=>window.jiwei.browser.state().then((state)=>state.tabs.find((tab)=>tab.id===id)?.sensitive),target.id)).toBe(true)
  await expect.poll(()=>readingPageEval<number>(env,'document.querySelectorAll("jiwei-reading[data-jiwei-ui]").length')).toBe(0)
  await expect(control()).toHaveCount(0)
})
test('段落只用 <br><br> 分隔的长文逐段插入译文，不堆在文末',async()=>{
  target=await browserReadingTarget(env,`${env.base}/essay`)
  const state=await env.page.evaluate((target)=>window.jiwei.reading.state(target),target)
  if(state.mode!=='parallel')await mode('对照')
  await expect.poll(()=>readingPageEval<number>(env,'document.querySelectorAll("jiwei-para + jiwei-reading[data-jiwei-ui]").length',target.id),{timeout:30000}).toBe(4)
  // 文字没有改变：原文顺序与内容一致，译文紧跟各自的段落。
  expect(await readingPageEval<string>(env,'[...document.querySelectorAll("jiwei-para")].map(p=>p.textContent).join("|")',target.id)).toBe(ESSAY.join('|'))
})
test('未配置模型时入口保留但不翻译，提示设置模型',async()=>{
  const sample=await startReadingApp({provider:false})
  try {
    const target=await browserReadingTarget(sample)
    const attempt=async():Promise<void>=>{await sample.page.getByTestId('reading-control').click();await sample.page.getByRole('menuitem',{name:'对照',exact:true}).click();await expect(sample.page.getByRole('button',{name:'去设置模型服务',exact:true}).last()).toBeVisible()}
    await attempt()
    await expect(sample.page.getByRole('dialog',{name:'开启对照阅读'})).toHaveCount(0)
    expect((await sample.page.evaluate((target)=>window.jiwei.reading.state(target),target)).mode).toBe('original');expect(sample.readingRequests).toHaveLength(0)
    await shot('reading-no-model-light.png',sample,undefined,attempt)
    await attempt();await sample.page.getByRole('button',{name:'去设置模型服务',exact:true}).last().dispatchEvent('click')
    await expect(sample.page.getByTestId('model-setup')).toBeVisible()
  } finally {await sample.close()}
})
