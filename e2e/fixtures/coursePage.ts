import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { createCanvas } from '@napi-rs/canvas'
import { execFileSync } from 'child_process'
import { createReadStream, existsSync, statSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import { homedir } from 'os'
import { join } from 'path'

export const COURSE_TITLE = '学习科学在线课'
export const COURSE_BODY = '本课程介绍间隔重复与提取练习。课后请合上书，回忆今天的两个学习方法，再安排下一次复习。'
export const COURSE_CUES = [
  { start: 0, end: 9, text: '第一讲，间隔重复。在快要遗忘的时候复习，让记忆保持得更久。' },
  { start: 9, end: 20, text: '复习间隔应随着掌握程度逐渐拉长，先隔一天，再隔三天。这里考试会考。' },
  { start: 20, end: 30, text: '第二讲，提取练习。合上书，自己回忆刚刚学过的内容。' },
  { start: 30, end: 40, text: '主动回忆比反复重读更有效。先尝试回答，再对照答案，找到自己还没掌握的地方。' }
]

/** 素材只在临时目录生成；中文画面与声音都来自真实的系统绘图、语音合成和 ffmpeg。 */
export async function makeCourseMedia(page: Page, dir: string): Promise<void> {
  const ffmpeg = join(homedir(), 'Library/Application Support/jiwei-models/ffmpeg/ffmpeg')
  if (!existsSync(ffmpeg)) {
    await page.evaluate(() => window.jiwei.asr.install())
    await expect.poll(() => page.evaluate(() => window.jiwei.asr.status().then((s) => s.state)), { timeout: 540_000 }).toBe('ready')
  }
  renderCourseMedia(dir, ffmpeg)
}

export function renderCourseMedia(dir: string, ffmpeg: string): void {
  const font = '"Hiragino Sans GB", "Heiti SC", "Songti SC", sans-serif'
  const slides = [
    { title: '第一讲 间隔重复', lines: ['在快要遗忘的时候复习', '一天 → 三天 → 一周', '这里考试会考'], color: '#244b92' },
    { title: '第二讲 提取练习', lines: ['合上书，自己回忆', '先回答 → 再对照答案', '主动回忆比重读更有效'], color: '#166b4f' }
  ]
  for (const [i, slide] of slides.entries()) {
    const canvas = createCanvas(1280, 720)
    const ctx = canvas.getContext('2d')
    // 两页保留各自真实的版式与色阶，使缩略图哈希也能区分换页。
    const background = ctx.createLinearGradient(0, 0, 1280, 0)
    background.addColorStop(0, i === 0 ? '#ffffff' : '#a8cfbc')
    background.addColorStop(1, i === 0 ? '#a8bbdd' : '#ffffff')
    ctx.fillStyle = background
    ctx.fillRect(0, 0, 1280, 720)
    ctx.fillStyle = slide.color
    ctx.fillRect(70, 72, 14, 92)
    ctx.font = `bold 62px ${font}`
    ctx.fillText(slide.title, 110, 140)
    ctx.font = `42px ${font}`
    slide.lines.forEach((line, j) => ctx.fillText(line, 110, 280 + j * 100))
    ctx.font = `26px ${font}`
    ctx.fillText(`学习科学 · ${i + 1} / 2`, 110, 660)
    writeFileSync(join(dir, `slide${i}.png`), canvas.toBuffer('image/png'))
    execFileSync(
      'say',
      [
        '-v',
        'Tingting',
        '-r',
        '190',
        '-o',
        join(dir, `voice${i}.aiff`),
        COURSE_CUES.slice(i * 2, i * 2 + 2)
          .map((c) => c.text)
          .join('')
      ],
      {
        timeout: 60_000
      }
    )
  }
  execFileSync(
    ffmpeg,
    [
      '-y',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-framerate',
      '10',
      '-i',
      join(dir, 'slide0.png'),
      '-i',
      join(dir, 'voice0.aiff'),
      '-loop',
      '1',
      '-framerate',
      '10',
      '-i',
      join(dir, 'slide1.png'),
      '-i',
      join(dir, 'voice1.aiff'),
      '-filter_complex',
      '[0:v]trim=duration=20,setpts=PTS-STARTPTS[v0];[1:a]apad,atrim=duration=20,asetpts=PTS-STARTPTS[a0];' +
        '[2:v]trim=duration=20,setpts=PTS-STARTPTS[v1];[3:a]apad,atrim=duration=20,asetpts=PTS-STARTPTS[a1];' +
        '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-t',
      '40',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      join(dir, 'v.mp4')
    ],
    { timeout: 120_000 }
  )
  const stamp = (t: number): string => `00:00:${String(t).padStart(2, '0')}.000`
  writeFileSync(join(dir, 'v.vtt'), `WEBVTT\n\n${COURSE_CUES.map((c) => `${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n')}`)
}

function courseHtml(subtitles: boolean, sensitive = false): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${COURSE_TITLE}</title>
  <style>body{font:16px/1.5 sans-serif;margin:12px}h1{font-size:22px;margin:8px 0}video{display:block;width:100%;max-height:62vh;background:#111}p{margin:10px 0}</style>
  </head><body><article><h1>${COURSE_TITLE}</h1><p>${COURSE_BODY}</p>
  ${sensitive ? '<form><label>课程密码 <input type="password" autocomplete="current-password"></label></form>' : ''}
  <video id="lecture" controls playsinline preload="auto" src="/v.mp4">
  ${subtitles ? '<track kind="subtitles" srclang="zh" label="中文" src="/v.vtt" default>' : ''}
  </video><p>第一讲：间隔重复。第二讲：提取练习。</p></article></body></html>`
}

/** 同源媒体支持 Range，确保 Chromium 的真实媒体加载与跳转不依赖一次下载完整文件。 */
export async function startCourseSite(dir: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/course' || path === '/course-nosub' || path === '/login/course') {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(courseHtml(path !== '/course-nosub', path === '/login/course'))
      return
    }
    if (path === '/empty') {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><html><head><title>课程目录</title></head><body><h1>课程目录</h1><p>请选择下一节课程。</p></body></html>')
      return
    }
    if (path !== '/v.mp4' && path !== '/v.vtt') return void res.writeHead(404).end()
    const file = join(dir, path.slice(1))
    const size = statSync(file).size
    const headers = { 'content-type': path === '/v.mp4' ? 'video/mp4' : 'text/vtt; charset=utf-8', 'accept-ranges': 'bytes' }
    const range = req.headers.range
    let start = 0,
      end = size - 1
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!m || (!m[1] && !m[2])) return void res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }).end()
      start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
      end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      if (start > end || start >= size) return void res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }).end()
    }
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
    })
    if (req.method === 'HEAD') return void res.end()
    const stream = createReadStream(file, { start, end })
    res.on('close', () => stream.destroy())
    stream.on('error', () => res.destroy()).pipe(res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

/** 多标签隐私用例必须按完整网址定位，不能误操作仍在后台的普通标签页。 */
export const inCoursePage = <T>(app: ElectronApplication, url: string, code: string): Promise<T> =>
  app.evaluate(
    async ({ webContents }, { url, code }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
      if (!wc) throw new Error(`Course page not found: ${url}`)
      return wc.executeJavaScript(code)
    },
    { url, code }
  ) as Promise<T>

export const courseView = (
  app: ElectronApplication,
  url: string
): Promise<{ visible: boolean; x: number; y: number; width: number; height: number } | null> =>
  app.evaluate(({ BrowserWindow, WebContentsView }, url) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
      (v) => v instanceof WebContentsView && v.webContents.getURL() === url
    )
    return view ? { ...view.getBounds(), visible: view.getVisible() } : null
  }, url)

/** 真正把焦点给网页，再经过 before-input-event 转发快捷键。 */
export const timestampShortcut = (app: ElectronApplication, url: string): Promise<void> =>
  app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
    if (!wc) throw new Error(`Course page not found: ${url}`)
    wc.focus()
    const modifiers: ('meta' | 'control' | 'shift')[] = [process.platform === 'darwin' ? 'meta' : 'control', 'shift']
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers })
  }, url)
