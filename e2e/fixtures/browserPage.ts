import { expect, type ElectronApplication } from '@playwright/test'
import { createServer, type Server } from 'http'
import { makePdf } from './makePdf'

// 内置浏览器测试的公共部分：本地网页服务、在原生网页视图中执行脚本、真实鼠标点击、网页中的选区浮条。

export const ARTICLE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>间隔重复的原理</title></head>
<body style="font: 16px/1.8 sans-serif; padding: 24px 32px">
<article>
<h1>间隔重复的原理</h1>
<p>间隔重复是在快要遗忘的时候复习，让记忆保持得更久。复习间隔应当随着掌握程度逐渐拉长，第一次隔一天，之后三天、一周、一个月。</p>
<p>提取练习：合上书，自己回忆刚学过的内容，比反复重读更有效。每次成功的回忆都会让记忆更牢固。</p>
<p><a id="dl" href="/lecture.pdf">下载讲义（PDF）</a></p>
</article></body></html>`
const HIDDEN_LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>带隐藏登录框的课程页</title></head><body>
<p>本节讲解提取练习。</p><div id="modal" style="display:none"><input type="password"></div></body></html>`
const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head><body>
<p>请输入账号和密码登录系统。</p><form><input name="u"><input type="password" name="p"></form></body></html>`

export async function startSite(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/article') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE)
    else if (req.url === '/hidden-login') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HIDDEN_LOGIN)
    else if (req.url === '/login') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN)
    else if (req.url === '/lecture.pdf')
      res
        .writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="lecture.pdf"' })
        .end(makePdf([['Lecture 3: Spaced repetition', 'Review just before you forget.']]))
    else res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

/** 在网页（原生视图）的主环境中执行脚本 */
export const inPage = <T>(app: ElectronApplication, code: string): Promise<T> =>
  app.evaluate(async ({ webContents }, code) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))
    if (!wc) throw new Error('no page')
    return wc.executeJavaScript(code)
  }, code) as Promise<T>

/** 向网页发送真实的鼠标点击（网页坐标） */
export const clickInPage = (app: ElectronApplication, x: number, y: number): Promise<void> =>
  app.evaluate(
    async ({ webContents }, { x, y }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!
      wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    },
    { x, y }
  )

/** 选中网页中的文字并松开鼠标，等浮条出现后用真实点击按下其中的按钮 */
export async function pageAction(app: ElectronApplication, text: string, action: string): Promise<void> {
  await inPage(
    app,
    `(() => {
    const t = ${JSON.stringify(text)}
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(t)
      if (i < 0) continue
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length)
      getSelection().removeAllRanges(); getSelection().addRange(r)
      const b = r.getBoundingClientRect()
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: b.left + 2, clientY: b.top + 2 }))
      return true
    }
    return false
  })()`
  )
  const attr = `document.querySelector('jiwei-toolbar')?.getAttribute('data-buttons') ?? null`
  await expect.poll(() => inPage<string | null>(app, attr), { timeout: 5000 }).not.toBeNull()
  const b = (JSON.parse((await inPage<string>(app, attr))!) as { action: string; x: number; y: number }[]).find((x) => x.action === action)!
  await clickInPage(app, b.x, b.y)
}
