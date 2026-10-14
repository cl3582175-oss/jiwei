/** 外部围栏永远只是文字。实体与全角字符只用于识别，不改变其余原文。 */
export function neutralizeUiFences(text: string): string {
  return text.replace(
    /^([ \t]*(?:(?:`|｀|&#(?:96|x60);|&grave;){3,}|~{3,})[ \t]*)jiwei-ui(?!-blocked)([^\r\n]*)/gim,
    (_match, fence: string, rest: string) => `${fence}jiwei-ui-blocked${rest}`
  )
}
