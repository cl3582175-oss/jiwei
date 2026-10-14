/** 只修正提取产物；不作繁简、大小写或标点改写。 */
export function normalizeExtracted(text: string): string {
  return [...text]
    .map((ch) => {
      const cp = ch.codePointAt(0)!
      // NFKC 未收录此补充部首的等价关系，规格明确要求这个有限例外。
      if (ch === '⻛') return '风'
      if (
        (cp >= 0x2e80 && cp <= 0x2eff) ||
        (cp >= 0x2f00 && cp <= 0x2fdf) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0x2f800 && cp <= 0x2fa1f)
      ) {
        const normalized = ch.normalize('NFKC')
        if (/^\p{Script=Han}$/u.test(normalized)) return normalized
      }
      if ((cp >= 0xff10 && cp <= 0xff19) || (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a))
        return String.fromCodePoint(cp - 0xfee0)
      if ((cp >= 0x200b && cp <= 0x200d) || cp === 0xfeff) return ''
      return cp === 0xa0 ? ' ' : ch
    })
    .join('')
}

export function normalizeQuery(text: string): string {
  return normalizeExtracted(text).replace(/\s+/g, ' ').trim()
}
