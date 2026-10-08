import { parse as parseYaml } from 'yaml'

// SKILL.md 解析与校验（Agent Skills 开放标准：https://agentskills.io/specification）。
// 纯函数，便于单元测试。

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface ParsedSkill {
  name: string
  description: string
  license: string | null
  metadata: Record<string, string>
  body: string
}

/** 解析 SKILL.md；不合规范时抛出带原因的错误 */
export function parseSkill(text: string, dirName?: string): ParsedSkill {
  const m = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) throw new Error('SKILL.md 缺少 YAML 头（--- 包围的 name 与 description）')
  const fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>
  const name = String(fm.name ?? '')
  const description = String(fm.description ?? '').trim()
  if (!NAME_RE.test(name) || name.length > 64) throw new Error(`技能名称不合规范：“${name}”（小写字母、数字与连字符，最长 64）`)
  if (dirName && dirName !== name) throw new Error(`技能名称“${name}”必须与文件夹名“${dirName}”一致`)
  if (!description || description.length > 1024) throw new Error('技能简介（description）必须为 1–1024 字')
  const metadata = Object.fromEntries(Object.entries((fm.metadata ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
  return { name, description, license: fm.license ? String(fm.license) : null, metadata, body: m[2].trim() }
}
