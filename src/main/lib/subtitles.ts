// 字幕（SRT / WebVTT）解析，以及把逐句的时间轴合并为适合阅读与检索的段落。

export interface Cue {
  start: number
  end: number
  text: string
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/

function seconds(s: string): number | null {
  const m = TIME.exec(s)
  if (!m) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}

/** 解析 SRT 或 WebVTT；去掉样式标签与重复行 */
export function parseSubtitles(raw: string): Cue[] {
  const blocks = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
  const cues: Cue[] = []
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim())
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i < 0) continue
    const [a, z] = lines[i].split('-->')
    const start = seconds(a)
    const end = seconds(z)
    if (start === null || end === null) continue
    const text = lines
      .slice(i + 1)
      .map((l) =>
        l
          .replace(/<[^>]+>/g, '')
          .replace(/\{\\[^}]+\}/g, '')
          .trim()
      )
      .filter(Boolean)
      .join(' ')
    if (!text) continue
    // 滚动字幕常重复上一句：去重
    if (cues.length && cues[cues.length - 1].text === text) {
      cues[cues.length - 1].end = end
      continue
    }
    cues.push({ start, end, text })
  }
  return cues
}

const fix1 = (n: number): string => (Math.round(n * 10) / 10).toString()

/**
 * 逐句 → 段落：停顿超过 gap 秒或段落超过 maxLen 秒时另起一段。
 * 片段的 locator 为 W3C 媒体片段 t=开始,结束（秒）。
 */
export function cuesToSegments(cues: Cue[], gap = 2.5, maxLen = 45): { kind: string; locator: Record<string, unknown>; text: string }[] {
  const out: { kind: string; locator: Record<string, unknown>; text: string }[] = []
  let cur: Cue | null = null
  const cjk = /[぀-ヿ㐀-鿿가-힯]$/
  const flush = (): void => {
    if (!cur) return
    out.push({
      kind: 'transcript',
      locator: {
        type: 'FragmentSelector',
        conformsTo: 'http://www.w3.org/TR/media-frags/',
        value: `t=${fix1(cur.start)},${fix1(cur.end)}`
      },
      text: cur.text.trim()
    })
    cur = null
  }
  for (const c of cues) {
    if (cur && (c.start - cur.end > gap || c.end - cur.start > maxLen)) flush()
    if (!cur) cur = { ...c }
    else {
      // 中文之间不加空格，西文之间加空格
      const sep: string = cjk.test(cur.text) || /^[㐀-鿿]/.test(c.text) ? '' : ' '
      cur = { start: cur.start, end: c.end, text: cur.text + sep + c.text }
    }
  }
  flush()
  return out
}
