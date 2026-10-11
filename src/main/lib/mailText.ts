import { parseHTML } from 'linkedom'
import { simpleParser } from 'mailparser'

export function mailBodyText(body: { text?: string; html?: string | false }): string {
  let text = body.text ?? ''
  if (body.html) {
    const { document } = parseHTML(`<html><body>${body.html}</body></html>`)
    document.querySelectorAll('script,style,blockquote,.gmail_quote,.yahoo_quoted,.moz-cite-prefix').forEach((n) => n.remove())
    document.querySelectorAll('br').forEach((n) => n.replaceWith(document.createTextNode('\n')))
    document.querySelectorAll('p,div,li').forEach((n) => n.appendChild(document.createTextNode('\n')))
    text = document.body.textContent ?? text
  }
  // 引用分隔线之后属于旧对话；逐行 > 引用同样不进入新邮件正文。
  text = text.split(/\n(?:On .{0,300}wrote:|在.{0,300}写道[：:]|[-_]{2,}\s*(?:Original Message|原始邮件)|From: .{0,300}\nSent:)/i)[0]
  return text
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 8000)
}
export async function parseMailPart(data: Buffer, options: { type: string; encoding?: string; charset?: string }): Promise<string> {
  const header = `Content-Type: ${options.type}; charset=${options.charset ?? 'utf-8'}\r\nContent-Transfer-Encoding: ${options.encoding ?? '8bit'}\r\n\r\n`
  const mail = await simpleParser(Buffer.concat([Buffer.from(header), data]), { skipHtmlToText: true, skipTextToHtml: true })
  return mailBodyText({ text: mail.text, html: mail.html })
}

/** 只选正文叶子；附件及嵌入邮件的树不取正文，避免下载附件或把旧邮件当新内容。 */
export function selectMailParts(structure: import('imapflow').MessageStructureObject): {
  bodies: import('imapflow').MessageStructureObject[]
  attachments: { name: string; size: number }[]
} {
  const bodies: import('imapflow').MessageStructureObject[] = [],
    attachments: { name: string; size: number }[] = []
  function visit(s: import('imapflow').MessageStructureObject) {
    const name = s.dispositionParameters?.filename ?? s.parameters?.name
    if (name || s.disposition?.toLowerCase() === 'attachment' || s.type === 'message/rfc822') {
      attachments.push({ name: name ?? 'attachment', size: s.size ?? 0 })
      return
    }
    if (s.childNodes) s.childNodes.forEach(visit)
    else if (['text/plain', 'text/html'].includes(s.type.toLowerCase())) bodies.push(s)
    else if (!s.type.startsWith('multipart/')) attachments.push({ name: name ?? 'attachment', size: s.size ?? 0 })
  }
  visit(structure)
  return { bodies: bodies.slice(0, 4), attachments }
}
export async function mailBodyFromParts(parts: import('imapflow').MessageStructureObject[], buffers: Map<string, Buffer>): Promise<string> {
  const texts: string[] = []
  for (const p of parts) {
    // ImapFlow 的解析器统一把 BODY[TEXT] 等部分键转成小写。
    const data = buffers.get((p.part || 'TEXT').toLowerCase())
    if (data) texts.push(await parseMailPart(data, { type: p.type, encoding: p.encoding, charset: p.parameters?.charset }))
  }
  return texts.join('\n').slice(0, 8000)
}
