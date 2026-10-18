/** Only current user text can express this choice; page content/tool args never call this parser. */
export function directReadIntent(text: string): { urls: string[]; requested: boolean; cloudUrl?: string } {
  const plain = text
    .replace(/(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/^(?: {4}|\t).*$/gm, '')
    .replace(/“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*'/g, '')
  const urls = [
    ...new Set(
      (plain.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []).map((value) => {
        let url = value.replace(/[\]}>，。！？；：,.!?;:]+$/u, '')
        while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1)
        return url
      })
    )
  ]
  const words = plain.replace(/https?:\/\/[^\s<>"'`]+/gi, '').trim()
  const negated =
    /(?:不要|不用|不使用|不需要|不允许|不得|切勿|别|不想|禁止|避免|do not|don't|never|must not|should not)[^\n。！？.!?]{0,60}(?:读|打开|访问|总结|概括|解释|分析|比较|read|fetch|open|summari[sz]e|explain|analy[sz]e|compare)/i.test(
      words
    )
  const requested =
    !!urls.length &&
    !negated &&
    (/(?:读|阅读|总结|概括|解释|分析|比较|对比|read|summari[sz]e|explain|analy[sz]e|compare|fetch)/i.test(words) ||
      /^[\s<>()[\]，。！？；：,.!?;:]*$/u.test(words))
  const cloudChoice =
    /^(?:请|请你|帮我|请帮我|麻烦你|你能|能否)?\s*(?:用|使用|通过|交给|让)\s*(?:deepseek|云端)(?:[^。！？\n]{0,20})(?:读|阅读|总结|抓取)/i.test(
      words
    ) ||
    /^(?:(?:please|can you|could you)\s+)?use\s+(?:deepseek|cloud)\s+to\s+(?:read|fetch|summari[sz]e)\b/i.test(words) ||
    /^(?:please\s+)?(?:read|fetch|summari[sz]e)\b[^.!?\n]{0,40}\b(?:using|with|via)\s+(?:deepseek|cloud)\b/i.test(words)
  const cloud =
    requested &&
    urls.length === 1 &&
    cloudChoice &&
    !/(?:不要|不用|不需要|without|don't|do not)[^\n。！？.!?]{0,25}(?:deepseek|云端|cloud)/i.test(words)
  return { urls, requested, ...(cloud ? { cloudUrl: urls[0] } : {}) }
}
