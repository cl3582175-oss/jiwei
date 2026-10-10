import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { startLensApp, type LensApp } from './fixtures/lensApp'
import { readingParts } from '../src/shared/readingText'
import { navTo } from './fixtures/nav'

// Explicit real-material acceptance, intentionally opt-in: 10+ minutes on EACH live page.
// Imports provider configuration only through the authorized application loader.
test.describe('v0.6.5 real English reading acceptance', () => {
  test.skip(
    !process.env.JIWEI_READING_REAL || !process.env.JIWEI_IMPORT_PROVIDERS_FROM,
    'Explicit timed real-material run with authorized provider loader'
  )
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(1_600_000)
  let env: LensApp
  const folder = resolve(process.env.SHOTS_DIR ?? '.superpowers/sdd/2026-10-10-mistakes-and-reading/evidence/real')
  const records: Record<string, unknown>[] = []

  test.beforeAll(async () => {
    mkdirSync(folder, { recursive: true })
    env = await startLensApp({ provider: false, importProviders: process.env.JIWEI_IMPORT_PROVIDERS_FROM })
    await env.app.evaluate(async ({ session, BrowserWindow }) => {
      await session
        .fromPartition('persist:jiwei-browser')
        .setProxy({ proxyRules: 'http=127.0.0.1:1082;https=127.0.0.1:1082', proxyBypassRules: '<local>' })
      BrowserWindow.getAllWindows()[0].setSize(1440, 900)
    })
    await env.app.evaluate(({ ipcMain }, file) => {
      ipcMain.on('jw-page:reading-error', (_event, raw) => {
        process.getBuiltinModule('fs').appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...raw }) + '\n')
      })
    }, join(folder, 'reading-errors.jsonl'))
    expect((await env.page.evaluate(() => window.jiwei.settings.get())).ai.chat.model).toBeTruthy()
    await env.page.keyboard.press('ControlOrMeta+n')
    await env.page.getByPlaceholder('笔记标题').fill('v0.6.5 真实英文阅读验收')
    await env.page.keyboard.press('Enter')
    await env.page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  })
  test.afterAll(async () => {
    writeFileSync(join(folder, 'reading-real.json'), JSON.stringify(records, null, 2))
    await env?.close()
  })

  async function native<T>(code: string): Promise<T> {
    return env.app.evaluate(async ({ webContents }, code) => {
      const view = webContents.getAllWebContents().find((wc) => /^https?:/.test(wc.getURL()))
      if (!view) throw new Error('Real browser view not found')
      return view.executeJavaScript(code)
    }, code) as Promise<T>
  }
  async function shot(name: string): Promise<void> {
    await env.app.evaluate(
      async ({ BrowserWindow, webContents }, file) => {
        const image = await BrowserWindow.getAllWindows()[0].capturePage()
        process.getBuiltinModule('fs').writeFileSync(file, image.toPNG())
        const browser = webContents.getAllWebContents().find((wc) => /^https?:/.test(wc.getURL()))
        if (browser)
          process.getBuiltinModule('fs').writeFileSync(file.replace(/\.png$/, '-browser.png'), (await browser.capturePage()).toPNG())
      },
      join(folder, name)
    )
  }
  async function selectOriginal(): Promise<string> {
    return native<string>(`(() => {
      const p=[...document.querySelectorAll('p,jiwei-para')].find(p=>!p.closest('[data-jiwei-ui],nav,footer')&&p.getClientRects().length&&p.textContent.trim().length>70);
      if(!p)throw Error('No visible original paragraph');
      p.scrollIntoView({block:'center'});
      const w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT); let n=w.nextNode();
      while(n && (n.textContent.trim().length<8 || n.parentElement?.closest('[data-jiwei-ui]')))n=w.nextNode();
      if(!n)throw Error('No original text node');
      const r=document.createRange();r.setStart(n,0);r.setEnd(n,Math.min(n.textContent.length,100));getSelection().removeAllRanges();getSelection().addRange(r);
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return r.toString();
    })()`)
  }
  async function clickToolbar(action: string): Promise<void> {
    const code = `document.querySelector('jiwei-toolbar')?.getAttribute('data-buttons') ?? null`
    await expect.poll(() => native<string | null>(code)).not.toBeNull()
    const buttons = JSON.parse((await native<string>(code))!) as { action: string; x: number; y: number }[]
    const button = buttons.find((item) => item.action === action)
    expect(button).toBeTruthy()
    await env.app.evaluate(({ webContents }, button) => {
      const view = webContents.getAllWebContents().find((wc) => /^https?:/.test(wc.getURL()))!
      const zoom = view.getZoomFactor()
      for (const type of ['mouseDown', 'mouseUp'] as const)
        view.sendInputEvent({ type, x: Math.round(button.x * zoom), y: Math.round(button.y * zoom), button: 'left', clickCount: 1 })
    }, button!)
  }

  interface CoverageRow { index: number; tag: string; text: string; translations: string[]; annotations: unknown[]; top: number }
  async function coverage(scrollIndex: number | null = null): Promise<CoverageRow[]> {
    return native<CoverageRow[]>(`(() => {
      const selector='p,li,blockquote,h1,h2,h3,h4,h5,h6,td,figcaption,jiwei-para';
      const excluded='[data-jiwei-ui],nav,footer,header,aside,button,input,textarea,select,pre,code,script,style,template,[hidden],[aria-hidden="true"],[role="navigation"],math,.katex,.MathJax,[class*="mathjax"]';
      const elements=[...document.querySelectorAll(selector)].filter(e=>{
        if(e.closest(excluded)||e.querySelector(selector))return false;
        for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}
        const r=e.getBoundingClientRect();return r.width>1&&r.height>0&&e.textContent.normalize('NFKC').replace(/\\s+/g,' ').trim().length>=2;
      });
      if(${scrollIndex ?? 'null'}!==null)elements[${scrollIndex ?? 'null'}]?.scrollIntoView({block:'center',behavior:'instant'});
      return elements.map((e,index)=>{
        const copy=e.cloneNode(true);copy.querySelectorAll('[data-jiwei-ui]').forEach(ui=>ui.remove());
        const host=e.nextElementSibling?.matches('jiwei-reading[data-jiwei-ui]')?e.nextElementSibling:e.querySelector(':scope > jiwei-reading[data-jiwei-ui]');
        const outputs=host?.dataset.signature?JSON.parse(host.dataset.signature)[2]:[];
        return {index,tag:e.tagName,text:copy.textContent,translations:outputs.map(o=>o?.translation??''),annotations:outputs.flatMap(o=>o?.annotations??[]),top:e.getBoundingClientRect().top+scrollY};
      });
    })()`)
  }

  async function retryReading(tabId: string, record: Record<string, unknown>): Promise<boolean> {
    const state = await env.page.evaluate((id) => window.jiwei.reading.state({ kind: 'browser', id }), tabId)
    if (!state.error) return false
    const retries = (record.retries ??= []) as unknown[]
    expect(retries.length, 'Bounded recovery must not hide repeated provider failures').toBeLessThan(8)
    retries.push({ at: new Date().toISOString(), error: state.error, revision: state.revision })
    writeFileSync(join(folder, 'reading-real.json'), JSON.stringify(records, null, 2))
    await shot(`${record.label}-retry-${retries.length}.png`)
    await env.page.getByTestId('reading-control').click()
    await env.page.getByRole('menuitem', { name: '重试', exact: true }).click()
    await expect.poll(() => env.page.evaluate((id) => window.jiwei.reading.state({ kind: 'browser', id }), tabId).then(s => s.revision)).toBeGreaterThan(state.revision)
    return true
  }

  for (const site of [
    { label: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Spaced_repetition' },
    { label: 'essay', url: 'https://paulgraham.com/think.html' }
  ]) {
    test(`${site.label}: live reading for at least 10 minutes, clean anchoring and source`, async () => {
      const tabId = await env.page.evaluate((url) => window.jiwei.browser.open(url, { newTab: true }), site.url)
      await expect
        .poll(() => env.page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)?.loading), tabId), {
          timeout: 60_000
        })
        .toBe(false)
      await expect
        .poll(() => env.page.evaluate((id) => window.jiwei.reading.state({ kind: 'browser', id }), tabId).then((s) => s.foreign), {
          timeout: 60_000
        })
        .toBe(true)
      const before = await native<{ url: string; title: string; characters: number; height: number; sample: string; overflow: number }>(
        `({url:location.href,title:document.title,characters:document.body.innerText.length,height:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth-innerWidth,sample:document.body.innerText.slice(0,6000)})`
      )
      await env.page.getByTestId('reading-control').click()
      await env.page.getByRole('menuitem', { name: '对照', exact: true }).click()
      const cost = env.page.getByRole('dialog', { name: '开启对照阅读' })
      if (site.label === 'wikipedia') {
        await expect(cost).toBeVisible()
        await cost.getByRole('checkbox').check()
        await cost.getByRole('button', { name: '开始阅读' }).click()
      }
      await expect
        .poll(() => native<number>(`document.querySelectorAll('jiwei-reading[data-jiwei-ui]').length`), { timeout: 120_000 })
        .toBeGreaterThan(0)
      await env.page.evaluate(
        (id) =>
          window.jiwei.reading.configure({ target: { kind: 'browser', id }, mode: 'parallel', annotations: true, initialThreshold: 12000 }),
        tabId
      )
      const startedAt = new Date().toISOString(),
        started = Date.now(),
        snapshots: unknown[] = []
      const record: Record<string, unknown> = { ...site, before, startedAt, snapshots, status: 'reading' }
      records.push(record)
      writeFileSync(join(folder, 'reading-real.json'), JSON.stringify(records, null, 2))
      await shot(`${site.label}-parallel.png`)
      // The real view remains active and translated during the whole interval. Visit all page sections and revisit them to exercise cached content.
      for (let step = 0; Date.now() - started < 610_000; step++) {
        const fraction = (step % 21) / 20
        await native(`scrollTo({top:(document.documentElement.scrollHeight-innerHeight)*${fraction},behavior:'instant'})`)
        await env.page.waitForTimeout(15_000)
        const snapshot = await native<{ y: number; hosts: number; sample: unknown[]; overflow: number }>(
          `({y:scrollY,hosts:document.querySelectorAll('jiwei-reading[data-jiwei-ui]').length,sample:[...document.querySelectorAll('jiwei-reading[data-signature]')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).slice(0,3).map(e=>JSON.parse(e.dataset.signature)),overflow:document.documentElement.scrollWidth-innerWidth})`
        )
        snapshots.push(snapshot)
        await retryReading(tabId, record)
        Object.assign(record, { elapsedMs: Date.now() - started })
        writeFileSync(join(folder, 'reading-real.json'), JSON.stringify(records, null, 2))
        if (step % 10 === 0) {
          await shot(`${site.label}-scroll-${step}.png`)
        }
        expect(snapshot.overflow).toBeLessThanOrEqual(Math.max(2, before.overflow))
      }
      const durationMs = Date.now() - started
      expect(durationMs).toBeGreaterThanOrEqual(600_000)
      Object.assign(record, { durationMs, endedAt: new Date().toISOString(), status: 'checking' })
      const target = { kind: 'browser' as const, id: tabId }
      // Finish every eligible original paragraph through the real viewport path.
      // The recorded usage is whole-page reading, not just the first visible batch.
      const missing = (rows: CoverageRow[]): CoverageRow[] => rows.filter(row => row.translations.filter(Boolean).length < readingParts(row.text).length)
      const drainStarted = Date.now()
      let rows = await coverage()
      while (missing(rows).length && Date.now() - drainStarted < 420_000) {
        await retryReading(tabId, record)
        const first = missing(rows)[0]
        await coverage(first.index)
        await env.page.waitForTimeout(5000)
        rows = await coverage()
        Object.assign(record, { coverage: rows, missing: missing(rows).map(row => ({ index: row.index, text: row.text, translated: row.translations.length })) })
        writeFileSync(join(folder, 'reading-real.json'), JSON.stringify(records, null, 2))
      }
      const estimate = await env.page.evaluate((target) => window.jiwei.reading.estimate(target), target)
      const translatedParagraphs = rows.reduce((total, row) => total + row.translations.filter(Boolean).length, 0)
      Object.assign(record, { coverage: rows, eligibleParagraphs: estimate.paragraphs, translatedParagraphs, drainMs: Date.now() - drainStarted })
      writeFileSync(join(folder, 'reading-real.json'), JSON.stringify(records, null, 2))
      expect(missing(rows), 'Every eligible original chunk must have a visible translation').toHaveLength(0)
      expect(translatedParagraphs).toBe(estimate.paragraphs)
      await env.page.evaluate((target) => window.jiwei.reading.configure({ target, mode: 'translation', annotations: false }), target)
      await native('scrollTo(0,0)')
      await expect
        .poll(() => native<number>(`document.querySelectorAll('jiwei-reading[data-mode="translation"]').length`))
        .toBeGreaterThan(0)
      await shot(`${site.label}-translation.png`)
      await env.page.evaluate((target) => window.jiwei.reading.configure({ target, mode: 'original', annotations: false }), target)
      await env.page.waitForTimeout(1000)
      await shot(`${site.label}-original.png`)
      await env.page.evaluate((target) => window.jiwei.reading.configure({ target, mode: 'parallel', annotations: true }), target)
      const quote = await selectOriginal()
      await clickToolbar('highlighting')
      const sourceId = await env.page.evaluate((id) => window.jiwei.browser.saveSource(id), tabId)
      await expect
        .poll(() => env.page.evaluate((id) => window.jiwei.annotations.list('source', id), sourceId).then((a) => a.length))
        .toBeGreaterThan(0)
      const annotations = await env.page.evaluate((id) => window.jiwei.annotations.list('source', id), sourceId)
      expect(annotations.some((a) => a.selector.quote === quote.replace(/\s+/g, ' ').trim())).toBe(true)
      expect(JSON.stringify(annotations.map((a) => a.selector))).not.toContain('data-jiwei-ui')
      await expect
        .poll(
          () =>
            env.page
              .evaluate((id) => window.jiwei.segments.list(id), sourceId)
              .then((segments) => segments.reduce((n, segment) => n + segment.text.length, 0)),
          { timeout: 60_000 }
        )
        .toBeGreaterThan(3000)
      const segments = await env.page.evaluate((id) => window.jiwei.segments.list(id), sourceId)
      expect(segments.map((segment) => segment.text).join('\n')).not.toMatch(/[\u3400-\u9fff]{8}/)
      const pageText = await env.page.evaluate((id) => window.jiwei.browser.readPage(id), tabId)
      expect(pageText.text.length).toBeGreaterThan(3000)
      expect(pageText.text).not.toMatch(/[\u3400-\u9fff]{8}/)
      const usage = await env.page.evaluate((target) => window.jiwei.reading.usage(target), target)
      Object.assign(record, {
        status: 'passed',
        sourceId,
        annotationSelectors: annotations.map((a) => a.selector),
        sourceCharacters: segments.reduce((n, s) => n + s.text.length, 0),
        pageTextCharacters: pageText.text.length,
        usage
      })
      writeFileSync(join(folder, 'reading-real.json'), JSON.stringify(records, null, 2))
      console.log(JSON.stringify({ site: site.label, durationMs, usage }))
      await env.page.evaluate((id) => window.jiwei.browser.close(id), tabId)
    })
  }

  test('real arXiv PDF: parallel translation on at least five pages', async () => {
    const file = resolve('.superpowers/sdd/2026-10-10-mistakes-and-reading/evidence/real/attention-is-all-you-need.pdf')
    const result = await env.page.evaluate((file) => window.jiwei.sources.importPaths([file]), file)
    expect(result.imported).toHaveLength(1)
    const source = result.imported[0]
    await expect
      .poll(() => env.page.evaluate((id) => window.jiwei.segments.list(id), source.id).then((s) => s.length), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(5)
    await navTo(env.page, /资料库/)
    await env.page.getByPlaceholder('搜索资料').fill(source.title)
    await env.page.getByText(source.title, { exact: true }).dblclick()
    await env.page.getByTestId('reading-control').click()
    await env.page.getByRole('menuitem', { name: '对照', exact: true }).click()
    // 单独运行本用例时首次开启会先问费用与水平。
    const costDialog = env.page.getByRole('dialog', { name: '开启对照阅读' })
    if (await costDialog.waitFor({ timeout: 5000 }).then(() => true, () => false)) await costDialog.getByRole('button', { name: '开始阅读', exact: true }).click()
    await expect(env.page.getByTestId('reading-pdf-text')).toBeVisible()
    const pages: unknown[] = []
    for (let number = 1; number <= 5; number++) {
      const sections = env.page.getByTestId('reading-pdf-text').locator(`:scope > div[data-page="${number}"]`)
      const parts: { original: string; translation: string }[] = []
      expect(await sections.count()).toBeGreaterThan(0)
      for (let part = 0; part < (await sections.count()); part++) {
        const section = sections.nth(part)
        await section.scrollIntoViewIfNeeded()
        await expect(section.getByTestId('reading-translation')).toBeVisible({ timeout: 120_000 })
        await shot(`arxiv-parallel-page-${number}-part-${part + 1}.png`)
        parts.push({
          original: await section.locator('p').innerText(),
          translation: await section.getByTestId('reading-translation').innerText()
        })
      }
      pages.push({
        page: number,
        parts
      })
    }
    const usage = await env.page.evaluate((id) => window.jiwei.reading.usage({ kind: 'source', id }), source.id)
    records.push({ material: 'arXiv:1706.03762', sourceId: source.id, pages, usage })
  })
})
