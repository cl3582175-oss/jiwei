/** 沿用真实上一问的主题；不凭短问猜资料或调用模型改写。 */
export function retrievalQuery(text: string, prevUserText: string | null): string {
  if (!prevUserText?.trim()) return text
  const current = text.trim(),
    short = [...current.replace(/[\p{P}\s]/gu, '')].length <= 12
  return short || /^(?:那|那么|它|它们|这个|那个|这份|那份|上面|刚才|还有|另外|其中)/.test(current) || /呢[\p{P}\s]*$/u.test(current)
    ? `${text}\n${[...prevUserText].slice(0, 200).join('')}`
    : text
}
