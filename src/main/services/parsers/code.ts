import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { decodeText } from './csv'
import type { SegmentInput } from '../segments'

export const CODE_EXTS = [
  'json',
  'yaml',
  'yml',
  'xml',
  'log',
  'py',
  'js',
  'ts',
  'tsx',
  'jsx',
  'java',
  'go',
  'rs',
  'c',
  'cpp',
  'h',
  'cs',
  'rb',
  'php',
  'sh',
  'sql',
  'ini',
  'toml'
]
const LANGUAGE: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  yml: 'yaml',
  rs: 'rust',
  cs: 'csharp',
  rb: 'ruby',
  sh: 'bash',
  h: 'c',
  log: 'text'
}
export async function parseCode(path: string, ext = extname(path).slice(1)): Promise<SegmentInput[]> {
  const text = decodeText(await readFile(path)).replace(/\r\n/g, '\n')
  if (!text.trim()) return []
  const lines = text.split('\n'),
    segments: SegmentInput[] = []
  for (let i = 0; i < lines.length; i += 120) {
    const body = lines.slice(i, i + 120).join('\n')
    const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`{3,}/g), (m) => m[0].length + 1)))
    segments.push({
      kind: 'code',
      text: `${fence}${LANGUAGE[ext] ?? ext}\n${body}\n${fence}`,
      locator: { lineStart: i + 1, lineEnd: Math.min(i + 120, lines.length), value: `lines=${i + 1}-${Math.min(i + 120, lines.length)}` }
    })
  }
  return segments
}
