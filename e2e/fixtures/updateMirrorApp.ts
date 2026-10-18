import { _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Tests the packaged default-source branch, not JIWEI_UPDATE_FEED.
 * Only the network/OS boundary is isolated; no real installer is fetched/run.
 */
export async function updateMirrorFixture(options: { userData?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jiwei-official-update-'))
  const userData = options.userData ?? join(root, 'user-data')
  const appData = join(root, 'app-data')
  for (const dir of [userData, appData]) mkdirSync(dir, { recursive: true })
  const control = {
    response: 'available' as 'available' | 'current' | 'unavailable' | 'html',
    nextVersion: '1.0.0',
    primary: false,
    hangPrimary: false,
    abortedPrimary: 0,
    firstMirror: true,
    requests: [] as string[]
  }
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  const sha512 = createHash('sha512').update('controlled metadata fixture, never an installer').digest('base64')
  const server = createServer((req, res) => {
    control.requests.push(req.url ?? '')
    if (req.url?.startsWith('/github/')) {
      if (control.hangPrimary) {
        res.on('close', () => {
          if (!res.writableFinished) control.abortedPrimary++
        })
        return
      }
      if (!control.primary) return void res.writeHead(503).end('GitHub blocked')
      if (req.url.includes('releases.atom'))
        return void res
          .writeHead(200, { 'content-type': 'application/atom+xml' })
          .end(
            `<feed><entry><title>Version</title><link href="https://github.com/cl3582175-oss/jiwei-releases/releases/tag/v${control.nextVersion}"/><content>GitHub release notes</content></entry></feed>`
          )
      if (/releases\/latest$/.test(req.url))
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tag_name: `v${control.nextVersion}` }))
    }
    if (req.url?.startsWith('/gh-proxy.com/') && !control.firstMirror) return void res.writeHead(503).end('First mirror unavailable')
    if (!/latest(?:-mac|-linux)?\.yml/.test(req.url ?? '')) return void res.writeHead(404).end('Unknown fixture route')
    if (control.response === 'unavailable') return void res.writeHead(503).end('Controlled service unavailable')
    if (control.response === 'html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Access denied</html>')
    const next = control.response === 'current' ? version : control.nextVersion
    const file = `Jiwei-${next}-mac-${process.arch}.dmg`
    res.writeHead(200, { 'content-type': 'text/yaml' })
    res.end(
      `version: ${next}\nreleaseNotes: "镜像更新说明"\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: 50\npath: ${file}\nsha512: ${sha512}\n`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const harness = join(root, 'main.cjs')
  writeFileSync(
    harness,
    `const {app,session,shell}=require('electron');
app.setPath('userData',${JSON.stringify(userData)});app.setPath('appData',${JSON.stringify(appData)});
app.setAppLogsPath(${JSON.stringify(join(root, 'logs'))});
app.getAppPath=()=>${JSON.stringify(process.cwd())};app.getVersion=()=>${JSON.stringify(version)};
Object.defineProperty(app,'isPackaged',{get:()=>true});
Object.defineProperty(process,'resourcesPath',{value:${JSON.stringify(join(process.cwd(), 'resources'))}});
// Prevent the packaged branch from registering a real OS protocol or treating Electron's signature as Jiwei's.
app.setAsDefaultProtocolClient=()=>false;
const getPath=app.getPath.bind(app);app.getPath=(name)=>name==='exe'?${JSON.stringify(join(root, 'unsigned.app/Contents/MacOS/Test'))}:getPath(name);
globalThis.__updateNetworkRequests=[];
globalThis.__updateOpenedLinks=[];shell.openExternal=async(url)=>{globalThis.__updateOpenedLinks.push(url)};
app.whenReady().then(()=>{
 for(const s of [session.defaultSession,session.fromPartition('electron-updater',{cache:false})]){
  void s.setProxy({mode:'direct'});
  s.webRequest.onBeforeRequest({urls:['*://*/*']},(d,cb)=>{
   const u=new URL(d.url);globalThis.__updateNetworkRequests.push(d.url);
   if(['github.com','api.github.com'].includes(u.hostname)) return cb({redirectURL:${JSON.stringify(local)}+'/github'+u.pathname+u.search});
   if(['gh-proxy.com','ghfast.top','custom-update.test'].includes(u.hostname)) return cb({redirectURL:${JSON.stringify(local)}+'/'+u.hostname+u.pathname+u.search});
   if(u.hostname==='127.0.0.1') return cb({});
   cb({cancel:true});
  });
 }
});
// Protocol privileges must be registered before Electron is ready.
require(${JSON.stringify(join(process.cwd(), 'out/main/index.js'))});`
  )
  let app
  try {
    app = await electron.launch({
      args: [harness, `--user-data-dir=${userData}`],
      env: {
        ...process.env,
        JIWEI_LANG: 'zh-CN',
        JIWEI_SKIP_ONBOARDING: '1',
        JIWEI_IMPORT_PROVIDERS_FROM: '',
        JIWEI_UPDATE_FEED: '',
        JIWEI_UPDATE_FORCE_PACKAGED: ''
      }
    })
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    return {
      app,
      page,
      userData,
      control,
      networkRequests: () => app.evaluate(() => (globalThis as unknown as { __updateNetworkRequests: string[] }).__updateNetworkRequests),
      openedLinks: () => app.evaluate(() => (globalThis as unknown as { __updateOpenedLinks: string[] }).__updateOpenedLinks),
      close: async () => {
        await app.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  } catch (error) {
    await app?.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }
}
