import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'

// 从 Finder / 开始菜单启动的应用拿到的 PATH 很短（没有 Homebrew、nvm、volta……），`npx` 之类的命令会找不到。
// 第一次需要时读取一次登录 shell 的 PATH，并补上常见目录。

let cached: Promise<string> | null = null
const EXTRA = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
const MARK = '__JIWEI_PATH__'

function merge(...parts: (string | undefined)[]): string {
  const seen = new Set<string>()
  for (const p of parts.flatMap((x) => (x ?? '').split(delimiter))) if (p) seen.add(p)
  return [...seen].join(delimiter)
}

export function loginPath(): Promise<string> {
  if (cached) return cached
  if (process.platform === 'win32') return (cached = Promise.resolve(process.env.PATH ?? ''))
  cached = new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeout: 6000, encoding: 'utf8' }, (err, stdout) => {
      const m = !err && new RegExp(`${MARK}(.*?)${MARK}`).exec(stdout)
      resolve(merge(m ? m[1] : undefined, process.env.PATH, ...EXTRA))
    })
  })
  return cached
}
