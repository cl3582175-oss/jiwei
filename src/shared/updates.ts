import { z } from 'zod'

export type UpdateMode = 'disabled' | 'mac-manual' | 'automatic' | 'download-page'
export interface UpgradeNotice {
  from: string
  to: string
  backupName?: string
  backupFailed?: boolean
}
export interface UpdateState {
  version: string
  platform: string
  arch: string
  mode: UpdateMode
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error'
  nextVersion?: string
  notes?: string
  notesTruncated?: boolean
  percent?: number
  /** 当前下载来源（主机名）与速度（字节 / 秒） */
  source?: string
  speed?: number
  error?: 'offline' | 'server' | 'checksum' | 'download' | 'storage'
  upgrade?: UpgradeNotice | null
}
export const UpdateSettingsSchema = z.object({
  autoCheck: z.boolean().optional(),
  feedUrl: z
    .string()
    .max(2000)
    .refine((value) => {
      if (!value.trim()) return true
      try {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      } catch {
        return false
      }
    }, 'Use a public HTTPS update feed without credentials or query parameters')
    .optional()
})

/*
 * 国内直连 GitHub 下载安装包常只有几十 KB/s。安装包走第三方加速镜像，按测速选最快的，
 * 失败或变慢时换下一个；版本信息和 SHA-512 仍从 GitHub 读取，镜像改不了校验值。
 */
const RELEASE_ASSET = /^https:\/\/github\.com\/cl3582175-oss\/jiwei-releases\/releases\/download\/[^?#]+$/
export const UPDATE_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/'] as const
/** 积微官方发布仓库的安装包地址 → [镜像…, 原地址]；其它地址（自定义更新源、测试源）原样返回 */
export function mirrorUrls(url: string): string[] {
  return RELEASE_ASSET.test(url) ? [...UPDATE_MIRRORS.map((m) => m + url), url] : [url]
}

function versionParts(version: string): { main: bigint[]; pre?: string[] } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) throw new Error('Invalid version')
  return { main: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') }
}
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a),
    y = versionParts(b)
  for (let i = 0; i < 3; i++) if (x.main[i] !== y.main[i]) return x.main[i] > y.main[i] ? 1 : -1
  if (!x.pre && !y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i],
      q = y.pre[i]
    if (p === q) continue
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q)
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1
    if (pn !== qn) return pn ? -1 : 1
    return p > q ? 1 : -1
  }
  return 0
}
export function updateMode(input: { platform: string; packaged: boolean; signed: boolean; appImage: boolean }): UpdateMode {
  if (!input.packaged) return 'disabled'
  if (input.platform === 'darwin') return input.signed ? 'automatic' : 'mac-manual'
  if (input.platform === 'win32' || (input.platform === 'linux' && input.appImage)) return 'automatic'
  return 'download-page'
}
