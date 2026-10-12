import { app, net } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync } from 'fs'
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import log from 'electron-log/main'
import { AnimationSchema, animationDuration, checkAnimation, sampleTransforms, type AnimationData, type ManimStatus } from '@shared/manim'
import { dataDir } from '../../db'
import { emit } from '../../events'
import { tr } from '../../lib/messages'
import { download, probeMirrors } from '../download'
import { registeredPlugin } from './registry'
import { pluginData, pluginRow } from './state'

// Manim 数学动画插件（v0.10）：运行环境按需下载、可整个删除。
//   micromamba + conda-forge 预编译包（按锁文件逐个校验 sha256，优先国内镜像）→ 离线建环境；
//   LaTeX 优先复用本机已有且包齐全的发行版，否则下载 TinyTeX 再装锁定的包列表；
//   渲染在 sandbox-exec 里进行：禁止联网，只允许写本次的临时目录；环境变量从空白开始，不借用 Homebrew 或用户的 Python。

export const MANIM_ID = 'manim@jiwei'
const CONDA_MIRRORS = [
  'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
  'https://mirrors.ustc.edu.cn/anaconda/cloud/conda-forge',
  'https://conda.anaconda.org/conda-forge'
]
const CTAN_MIRRORS = ['https://mirrors.tuna.tsinghua.edu.cn/CTAN', 'https://mirrors.ustc.edu.cn/CTAN', 'https://mirror.ctan.org']
const MICROMAMBA = {
  arm64: { sub: 'osx-arm64', size: 6337214, sha256: 'ae0b50b441fef93abd20711f18b074359a7f8f1f523a8046a4d6ab44aa68ff1b' },
  x64: { sub: 'osx-64', size: 6439300, sha256: '78b845ea7789d20c0917e60099cd5ea38d684d8d01ce6a8b64c3d919948f8f7b' }
} as const
const TINYTEX = {
  url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.09/TinyTeX-0-darwin-v2026.09.tar.xz',
  size: 1608824,
  sha256: '1b1f94321bd8f99ffd8fa9062b4305553d77f4c241bb5a37f15e913fd79f7622'
}
/** 首次下载的估计大小：conda 包约 170 MB；TinyTeX 与 LaTeX 包约 35 MB。装好后约 0.9 GB（复用本机 LaTeX 时约 0.75 GB） */
const ESTIMATE = { conda: 170e6, tex: 35e6, installed: 760e6, texInstalled: 170e6 }
const SCENES = {
  derivation: 'Derivation',
  'function-transform': 'FunctionTransform',
  'number-line': 'NumberLineScene',
  geometry: 'Geometry'
} as const
const PALETTE = { paper: '#FBFCFA', ink: '#1F2523', muted: '#6B746F', accent: '#2F6F62', accent2: '#B4654A', axis: '#AEB8B3' }
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const runtimeDir = (): string => join(pluginData(MANIM_ID), 'runtime')
const python = (): string => join(runtimeDir(), 'conda', 'bin', 'python')
interface Saved {
  tex: 'tinytex' | 'system'
  texBin: string
  bytes: number
}
let job: { controller: AbortController; progress: number; phase: ManimStatus['phase'] } | null = null
let lastError: string | null = null
let texProbe: Promise<string | null> | null = null

const supported = (): boolean => process.platform === 'darwin' && (process.arch === 'arm64' || process.arch === 'x64')
const plat = (): { sub: string; size: number; sha256: string } => MICROMAMBA[process.arch === 'arm64' ? 'arm64' : 'x64']
function pluginRoot(): string {
  const parsed = registeredPlugin(MANIM_ID)
  if (!parsed) throw new Error(tr('请先安装“数学动画”插件', 'Install the Math animation plugin first'))
  return parsed.root
}
async function saved(): Promise<Saved | null> {
  try {
    const s = JSON.parse(await readFile(join(runtimeDir(), 'state.json'), 'utf8')) as Saved
    // bytes 只在试渲染通过后写入：中途崩溃留下的不完整环境不算就绪
    return existsSync(python()) && s.bytes > 0 ? s : null
  } catch {
    return null
  }
}
function changed(): void {
  emit('plugins:changed', {})
}

/* ——— 本机 LaTeX ——— */

/** 隔离环境运行命令：环境变量从空白开始，只给系统目录和指定的 bin */
function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; signal?: AbortSignal; timeout?: number } = {}
) {
  return new Promise<{ code: number; out: string }>((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { PATH: SYSTEM_PATH, LANG: 'en_US.UTF-8', ...opts.env },
      signal: opts.signal,
      timeout: opts.timeout
    })
    let out = ''
    p.stdout.on('data', (d) => (out = (out + d).slice(-20000)))
    p.stderr.on('data', (d) => (out = (out + d).slice(-20000)))
    p.on('error', reject)
    p.on('close', (code, sig) => resolve({ code: code ?? -1, out: sig ? `${out}\n(signal ${sig})` : out }))
  })
}
async function texFiles(): Promise<string[]> {
  const text = await readFile(join(pluginRoot(), 'jiwei', 'runtime', 'tex.txt'), 'utf8')
  const lines = text.split('\n')
  return lines[lines.indexOf('# files:') + 1].trim().split(/\s+/)
}
async function texPackages(): Promise<string[]> {
  const text = await readFile(join(pluginRoot(), 'jiwei', 'runtime', 'tex.txt'), 'utf8')
  const lines = text.split('\n')
  return lines[lines.indexOf('# packages:') + 1].trim().split(/\s+/)
}
/** 本机已有、包齐全的 LaTeX（只读使用，不运行 tlmgr）：返回它的 bin 目录 */
export function systemTex(): Promise<string | null> {
  texProbe ??= (async () => {
    const dirs = ['/Library/TeX/texbin']
    try {
      for (const year of await readdir('/usr/local/texlive')) dirs.push(join('/usr/local/texlive', year, 'bin', 'universal-darwin'))
    } catch {
      /* 没有 TeX Live */
    }
    const files = await texFiles().catch(() => [] as string[])
    for (const dir of dirs) {
      if (!files.length || !['kpsewhich', 'latex', 'dvisvgm'].every((b) => existsSync(join(dir, b)))) continue
      const r = await run(join(dir, 'kpsewhich'), files, { env: { PATH: `${dir}:${SYSTEM_PATH}` }, timeout: 20_000 }).catch(() => null)
      if (r?.code === 0 && r.out.trim().split('\n').filter(Boolean).length >= files.length) return dir
    }
    return null
  })()
  return texProbe
}

async function dirBytes(dir: string): Promise<number> {
  let n = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += await dirBytes(p)
    else if (e.isFile()) n += (await lstat(p)).size
  }
  return n
}

export async function manimStatus(): Promise<ManimStatus> {
  const s = supported() ? await saved() : null
  const tex = supported() ? await systemTex() : null
  return {
    state: !supported() ? 'unsupported' : job ? 'installing' : s ? 'ready' : lastError ? 'error' : 'missing',
    progress: job?.progress ?? (s ? 1 : 0),
    phase: job?.phase ?? null,
    bytes: s?.bytes ?? 0,
    estimate: ESTIMATE.conda + (tex ? 0 : ESTIMATE.tex),
    systemTex: tex,
    tex: s?.tex ?? null,
    error: job ? null : lastError
  }
}
export async function manimReady(): Promise<boolean> {
  if (!supported()) return false
  try {
    if (!pluginRow(MANIM_ID).enabled || !registeredPlugin(MANIM_ID)) return false
  } catch {
    return false
  }
  return !!(await saved())
}

/* ——— 安装 ——— */

function progress(phase: ManimStatus['phase'], value: number): void {
  if (!job) return
  job.phase = phase
  job.progress = Math.max(job.progress, Math.min(1, value))
  changed()
}
/** 下载一个 conda 包：按镜像顺序尝试，边下边算 sha256，不一致就换镜像 */
async function fetchPackage(paths: string[], dest: string, sha256: string, signal: AbortSignal): Promise<number> {
  const errors: string[] = []
  for (const url of paths) {
    signal.throwIfAborted()
    try {
      const res = await net.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const hash = createHash('sha256')
      const out = createWriteStream(`${dest}.part`)
      let n = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        n += value.length
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
      if (hash.digest('hex') !== sha256) throw new Error(tr('校验失败', 'checksum mismatch'))
      await rename(`${dest}.part`, dest)
      return n
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`)
      await rm(`${dest}.part`, { force: true })
    }
  }
  throw new Error(`${basename(dest)}：${errors.slice(-2).join('；')}`)
}

const MACHO = new Set(['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'feedface', 'cefaedfe'])
async function machO(file: string): Promise<boolean> {
  const fh = await open(file, 'r').catch(() => null)
  if (!fh) return false
  try {
    const b = Buffer.alloc(4)
    await fh.read(b, 0, 4, 0)
    return MACHO.has(b.toString('hex'))
  } finally {
    await fh.close()
  }
}
/** 给目录里签名失效的 Mach-O 文件补临时签名（ad-hoc） */
async function resign(dir: string, signal: AbortSignal): Promise<void> {
  const files: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && (/\.(dylib|so)$/.test(e.name) || ((await lstat(p)).mode & 0o111) !== 0) && (await machO(p))) files.push(p)
    }
  }
  await walk(dir)
  for (let i = 0; i < files.length; i += 40) {
    signal.throwIfAborted()
    const batch = files.slice(i, i + 40)
    const bad: string[] = []
    for (const f of batch) if ((await run('/usr/bin/codesign', ['--verify', f], { signal })).code !== 0) bad.push(f)
    if (bad.length) {
      const r = await run('/usr/bin/codesign', ['--force', '--sign', '-', ...bad], { signal })
      if (r.code !== 0) throw new Error(tr(`重新签名失败：${r.out.slice(-300)}`, `Re-signing failed: ${r.out.slice(-300)}`))
    }
  }
}

export async function installManim(opts: { useSystemTex?: boolean } = {}): Promise<void> {
  if (!supported()) throw new Error(tr('数学动画目前只支持 macOS', 'Math animation currently supports macOS only'))
  if (job) return
  const root = pluginRoot()
  const controller = new AbortController(),
    signal = controller.signal
  job = { controller, progress: 0, phase: 'micromamba' }
  lastError = null
  changed()
  const rt = runtimeDir(),
    pkgs = join(rt, 'downloads')
  const isolated = {
    HOME: join(rt, 'home'),
    MAMBA_ROOT_PREFIX: join(rt, 'mamba-root'),
    XDG_CACHE_HOME: join(rt, 'home', 'cache'),
    XDG_CONFIG_HOME: join(rt, 'home', 'config')
  }
  try {
    await rm(rt, { recursive: true, force: true })
    await mkdir(pkgs, { recursive: true })
    await mkdir(isolated.HOME, { recursive: true })
    const p = plat()
    // 1. micromamba（约 6 MB）
    const ranked = (await probeMirrors(CONDA_MIRRORS.map((m) => `${m}/noarch/manim-0.19.0-pyh29332c3_0.conda`))).map((r) =>
      r.url.replace(/\/noarch\/.*$/, '')
    )
    const mirrors = [...ranked, ...CONDA_MIRRORS.filter((m) => !ranked.includes(m))]
    const mm = join(pkgs, 'micromamba.tar.bz2')
    await download(
      {
        name: 'micromamba',
        size: p.size,
        sha256: p.sha256,
        urls: mirrors.map((m) => `${m}/${p.sub}/micromamba-2.3.2-0.tar.bz2`),
        dest: mm
      },
      (d) => progress('micromamba', (d.received / d.total) * 0.03),
      signal
    )
    await mkdir(join(rt, 'mamba'), { recursive: true })
    const untar = await run('/usr/bin/tar', ['-xjf', mm, '-C', join(rt, 'mamba'), 'bin/micromamba'], { signal })
    if (untar.code !== 0) throw new Error(untar.out)
    // 2. conda 包：逐个校验 sha256，6 个并行
    const lock = (await readFile(join(root, 'jiwei', 'runtime', `conda-${p.sub}.txt`), 'utf8'))
      .split('\n')
      .filter((l) => l.startsWith('https://'))
      .map((l) => {
        const [url, sha] = l.split('#')
        return { rel: url.replace('https://conda.anaconda.org/conda-forge/', ''), sha }
      })
    let done = 0
    const queue = [...lock]
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          await fetchPackage(
            mirrors.map((m) => `${m}/${item!.rel}`),
            join(pkgs, basename(item.rel)),
            item.sha,
            signal
          )
          progress('packages', 0.03 + (++done / lock.length) * 0.6)
        }
      })
    )
    // 3. 离线建环境，然后删掉包缓存和用不到的文件（文档、头文件、静态库）
    progress('environment', 0.64)
    const local = ['@EXPLICIT', ...lock.map((l) => `file://${join(pkgs, basename(l.rel))}#${l.sha}`)].join('\n')
    await writeFile(join(pkgs, 'explicit.txt'), local)
    const create = await run(
      join(rt, 'mamba', 'bin', 'micromamba'),
      ['create', '-y', '--no-rc', '--offline', '-p', join(rt, 'conda'), '--file', join(pkgs, 'explicit.txt')],
      { env: isolated, signal, timeout: 15 * 60_000 }
    )
    if (create.code !== 0) throw new Error(create.out.slice(-1500))
    await rm(pkgs, { recursive: true, force: true })
    await rm(isolated.MAMBA_ROOT_PREFIX, { recursive: true, force: true })
    for (const d of ['include', 'share/doc', 'share/man', 'share/gtk-doc', 'share/info'])
      await rm(join(rt, 'conda', d), { recursive: true, force: true })
    // 离线安装时 micromamba 替换了二进制里的路径前缀却没有重新签名，Apple 芯片会直接杀掉进程：逐个补临时签名
    await resign(join(rt, 'conda'), signal)
    progress('environment', 0.76)
    // 预编译 .pyc：渲染时不写字节码，没有预编译每次都要从源码重新编译
    const compile = await run(python(), ['-W', 'ignore', '-m', 'compileall', '-q', '-j', '0', join(rt, 'conda', 'lib')], {
      env: isolated,
      signal,
      timeout: 5 * 60_000
    })
    if (compile.code !== 0) log.warn('[manim] compileall', compile.out.slice(-400))
    progress('environment', 0.8)
    // 4. LaTeX：本机齐全就复用（只读），否则 TinyTeX + 锁定的包列表
    let tex: Saved['tex'] = 'tinytex',
      texBin = join(rt, 'TinyTeX', 'bin', 'universal-darwin')
    const sys = opts.useSystemTex === false ? null : await systemTex()
    if (sys) {
      tex = 'system'
      texBin = sys
    } else {
      progress('tex', 0.81)
      const tarball = join(rt, 'tinytex.tar.xz')
      await download({ name: 'TinyTeX', ...TINYTEX, urls: [TINYTEX.url], dest: tarball }, () => undefined, signal)
      const x = await run('/usr/bin/tar', ['-xJf', tarball, '-C', rt], { signal })
      if (x.code !== 0) throw new Error(x.out)
      await rm(tarball, { force: true })
      const ctan = (await probeMirrors(CTAN_MIRRORS.map((m) => `${m}/systems/texlive/tlnet/tlpkg/texlive.tlpdb.sha512`)))[0]?.url
      const repo = (ctan ?? `${CTAN_MIRRORS[0]}/systems/texlive/tlnet/tlpkg/texlive.tlpdb.sha512`).replace(
        '/tlpkg/texlive.tlpdb.sha512',
        ''
      )
      const texEnv = {
        ...isolated,
        PATH: `${texBin}:${SYSTEM_PATH}`,
        TEXMFHOME: join(rt, 'home', 'texmf'),
        TEXMFVAR: join(rt, 'TinyTeX', 'texmf-var'),
        TEXMFCONFIG: join(rt, 'TinyTeX', 'texmf-config')
      }
      const tlmgr = join(texBin, 'tlmgr')
      for (const args of [
        ['option', 'repository', repo],
        ['update', '--self'],
        ['install', ...(await texPackages())]
      ]) {
        const r = await run(tlmgr, args, { env: texEnv, signal, timeout: 10 * 60_000 })
        if (r.code !== 0) throw new Error(`tlmgr ${args[0]}：${r.out.slice(-800)}`)
        progress('tex', (job?.progress ?? 0.8) + 0.05)
      }
    }
    // 5. 试渲染一段，确认真的能用
    progress('verify', 0.96)
    const test = await renderNow(
      AnimationSchema.parse({ kind: 'derivation', steps: [{ tex: 'a^2-b^2' }, { tex: '(a+b)(a-b)' }] }),
      { duration: 2, width: 320, height: 128 },
      { tex, texBin, bytes: 0 }
    )
    await rm(test, { force: true })
    await writeFile(join(rt, 'state.json'), JSON.stringify({ tex, texBin, bytes: await dirBytes(rt) }))
    log.info('[manim] installed', tex, texBin)
  } catch (e) {
    lastError = signal.aborted ? null : e instanceof Error ? e.message.slice(0, 600) : String(e)
    log.warn('[manim] install failed', lastError)
    // 开发调试时可保留失败现场
    if (app.isPackaged || process.env.JIWEI_KEEP_FAILED_MANIM !== '1') await rm(rt, { recursive: true, force: true }).catch(() => undefined)
    if (!signal.aborted) throw e
  } finally {
    job = null
    changed()
  }
}
export function cancelManim(): void {
  job?.controller.abort()
}
/** 删除运行环境：整个目录删掉，返回释放的字节数 */
export async function removeManim(): Promise<number> {
  cancelManim()
  const bytes = await dirBytes(runtimeDir())
  await rm(runtimeDir(), { recursive: true, force: true })
  lastError = null
  changed()
  return bytes
}

/** 同步判断（给助手工具列表用）：插件启用且运行环境装好 */
export function manimAvailable(): boolean {
  if (!supported()) return false
  try {
    if (!pluginRow(MANIM_ID).enabled || !registeredPlugin(MANIM_ID)) return false
  } catch {
    return false
  }
  return existsSync(python()) && existsSync(join(runtimeDir(), 'state.json')) && !job
}

export const animationsDir = (): string => join(dataDir(), 'animations')
/** 笔记里的动画：按参数哈希缓存，同样的参数只渲染一次；返回 jiwei:// 地址 */
export async function animationClip(input: AnimationData): Promise<string> {
  const a = AnimationSchema.parse(input)
  const err = checkAnimation(a)
  if (err) throw new Error(err)
  const hash = createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0, 32)
  const file = join(animationsDir(), `${hash}.webm`)
  if (!existsSync(file)) {
    const tmp = await renderAnimation(a, { duration: animationDuration(a) })
    await mkdir(animationsDir(), { recursive: true })
    await rename(tmp, file)
  }
  return `jiwei://animations/${hash}.webm`
}

/* ——— 渲染 ——— */

let queue: Promise<unknown> = Promise.resolve()
/** 渲染一段动画为 webm（返回临时文件路径，调用方负责移走或删除）。一次只渲染一段。 */
export function renderAnimation(input: AnimationData, opts: { duration: number; width?: number; height?: number }): Promise<string> {
  const next = queue.then(() => renderNow(AnimationSchema.parse(input), opts))
  queue = next.catch(() => undefined)
  return next
}
async function renderNow(a: AnimationData, opts: { duration: number; width?: number; height?: number }, state?: Saved): Promise<string> {
  const s = state ?? (await saved())
  if (!s) throw new Error(tr('数学动画的运行环境还没有下载', 'The math animation runtime is not installed'))
  const width = opts.width ?? 1088,
    height = opts.height ?? 432
  const work = await realpath(await mkdtemp(join(app.getPath('temp'), 'jiwei-manim-')))
  try {
    const params = a.kind === 'function-transform' ? { xRange: a.xRange, yRange: a.yRange, stages: sampleTransforms(a) } : a
    await writeFile(
      join(work, 'scene.json'),
      JSON.stringify({ params, duration: opts.duration, palette: PALETTE, font: 'PingFang SC' }, (_, v) => (Number.isNaN(v) ? null : v))
    )
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(deny file-write*)',
      '(allow file-write-data (literal "/dev/null"))',
      `(allow file-write* (subpath ${JSON.stringify(work)}))`
    ].join('\n')
    await writeFile(join(work, 'sandbox.sb'), profile)
    // 关掉 Manim 渲染后联网检查新版本（沙箱里本来也连不上）
    await writeFile(join(work, 'manim.cfg'), '[CLI]\nnotify_outdated_version = False\n')
    const env = {
      HOME: work,
      TMPDIR: work,
      XDG_CACHE_HOME: join(work, 'cache'),
      XDG_CONFIG_HOME: join(work, 'config'),
      TEXMFVAR: join(work, 'texvar'),
      TEXMFCONFIG: join(work, 'texconfig'),
      PYTHONDONTWRITEBYTECODE: '1',
      PATH: `${join(runtimeDir(), 'conda', 'bin')}:${s.texBin}:${SYSTEM_PATH}`,
      JIWEI_SCENE: join(work, 'scene.json')
    }
    const script = join(pluginRoot(), 'jiwei', 'manim', 'jiwei_scenes.py')
    // LGPL 版 ffmpeg 没有 x264；输出 webm 时 Manim 改用 VP9（BSD 许可），Chromium 能直接播放和逐帧定位
    const args = [
      '-W',
      'ignore',
      '-m',
      'manim',
      'render',
      '--disable_caching',
      '--media_dir',
      join(work, 'media'),
      '-r',
      `${width},${height}`,
      '--fps',
      '30',
      '--format',
      'webm',
      '-o',
      'out',
      '--progress_bar',
      'none',
      '-v',
      'WARNING',
      script,
      SCENES[a.kind]
    ]
    const sandbox = '/usr/bin/sandbox-exec'
    const r = existsSync(sandbox)
      ? await run(sandbox, ['-f', join(work, 'sandbox.sb'), python(), ...args], { env, cwd: work, timeout: 120_000 })
      : await run(python(), args, { env, cwd: work, timeout: 120_000 })
    const out = join(work, 'media', 'videos', 'jiwei_scenes', `${height}p30`, 'out.webm')
    if (r.code !== 0 || !existsSync(out)) {
      // 报错摘要去掉本机路径再给用户看
      const msg =
        r.out.split(work).join('…').split(app.getPath('home')).join('~').trim().split('\n').slice(-6).join('\n') ||
        tr(`进程退出码 ${r.code}`, `exit code ${r.code}`)
      throw new Error(tr(`数学动画没能生成：${msg}`, `Math animation failed: ${msg}`))
    }
    const dest = join(app.getPath('temp'), `jiwei-anim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`)
    await rename(out, dest)
    return dest
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}
