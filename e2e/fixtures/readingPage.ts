import { createServer, type Server } from 'http'
import { makePdf } from './makePdf'

export const READING_SENTENCE='Epistemology clarifies the methodology of a heuristic paradigm.'
export const READING_PAGE=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reading integrity article</title><style>body{margin:0;padding:24px;font:17px/1.8 sans-serif}main{min-width:1200px;max-width:1280px}p{max-width:760px;min-height:170px;margin:18px 0}td{max-width:500px}nav{height:20px}</style></head><body>
<nav><p>Navigation pseudoscience is not reading data.</p></nav><main><h1>Knowledge and learning</h1><p id="first">${READING_SENTENCE} Common words are left unannotated.</p><ul><li>Terminology in a list has its own context.</li></ul><table><tr><td>Quantifying uncertainty requires contextual evidence.</td></tr></table>
<pre><code>const hiddenCode = 'epistemology';</code></pre><div style="display:none"><p>HIDDEN LOGIN TEXT epistemology</p><input type="password"></div><p class="katex">FORMULA SHOULD NOT TRANSLATE x squared</p>
<p id="rerender">A nuanced interpretation of the paradigm uses empirical evidence.</p>
${Array.from({length:65},(_,i)=>`<p id="paragraph-${i}">Paragraph ${i+1}. This research examines epistemology and heuristic methodology while preserving qualifications, scope and contextual evidence.</p>`).join('')}
</main><script>setTimeout(()=>{const p=document.createElement('p');p.id='delayed';p.textContent='Delayed empirical material is inserted after the page has loaded.';document.querySelector('#first').after(p)},1000);setTimeout(()=>history.replaceState({},'',location.pathname+'?utm_source=dynamic'),1400)</script></body></html>`
/** paulgraham.com 式排版：整篇一个元素，段落只用 <br><br> 分隔。 */
export const ESSAY=[
  'The first paragraph explains why independent thinking matters for research and for building companies that others overlook.',
  'The second paragraph argues that conventional people rarely notice how conventional they are, because their beliefs match those of their peers.',
  'The third paragraph describes how curiosity and fastidiousness about truth combine to make someone resistant to fashionable ideas.',
  'The fourth paragraph concludes that you can cultivate independence by choosing the right friends and the right problems to work on.'
]
export async function startReadingSite():Promise<{server:Server;base:string}> {
  const server=createServer((request,response)=>{
    const path=new URL(request.url ?? '/','http://localhost').pathname
    if(path==='/article')response.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(READING_PAGE)
    else if(path==='/essay')response.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<html lang="en"><head><title>Break essay</title></head><body><table><tr><td><font size="2">${ESSAY.join('<br><br>')}</font></td></tr></table></body></html>`)
    else if(path==='/chinese')response.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<html lang="zh"><head><title>中文阅读</title></head><body><main><p>这是中文资料，讨论学习方法与知识结构，不需要对照翻译。</p></main></body></html>')
    else if(path==='/login')response.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<html lang="en"><body><p>Log in to a private account.</p><input type="password"></body></html>')
    else if(path==='/reading.pdf')response.writeHead(200,{'content-type':'application/pdf'}).end(makePdf(Array.from({length:6},(_,i)=>[`Research paper page ${i+1}`,READING_SENTENCE,'Technical terminology relates to empirical evidence.'])))
    else response.writeHead(404).end()
  })
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve))
  return {server,base:`http://127.0.0.1:${(server.address() as {port:number}).port}`}
}
