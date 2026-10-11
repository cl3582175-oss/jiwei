import { app } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ImapFlow, type FetchMessageObject, type SearchObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import { type MailContent, type MailQuery, type MailSummary, MailList } from '@shared/mail'
import { accountRow, accounts, setMailError } from './accounts'
import { openJson } from '../mcp/secrets'
import { mailBodyText, mailBodyFromParts, selectMailParts } from '../../lib/mailText'
import { tr } from '../../lib/messages'

export interface MailReader {
  uidValidity: string
  lastUid: number
  list(query: MailQuery & { afterUid?: number }): Promise<MailContent[]>
  read(uid: number): Promise<MailContent>
}
const mailId = (accountId: string, validity: string, uid: number): string => `${accountId}:${validity}:${uid}`
export function fixtureMailEnabled(): boolean {
  return !app.isPackaged && process.env.JIWEI_TEST_MAIL === 'fixture'
}
async function fixtureReader(accountId: string): Promise<MailReader> {
  const dir = process.env.JIWEI_TEST_MAIL_DIR ?? join(app.getAppPath(), 'e2e/fixtures/mail')
  const names = (await readdir(dir)).filter((n) => /^\d+.*\.eml$/i.test(n)).sort((a, b) => parseInt(a) - parseInt(b))
  const mails: MailContent[] = []
  for (const name of names.slice(0, 1000)) {
    const file = join(dir, name)
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('Fixture mail too large')
    const parsed = await simpleParser(await readFile(file), { skipHtmlToText: true, skipTextToHtml: true }),
      text = mailBodyText({ text: parsed.text, html: parsed.html }),
      uid = parseInt(name)
    mails.push({
      id: mailId(accountId, 'fixture-1', uid),
      accountId,
      from: parsed.from?.text ?? '',
      subject: parsed.subject ?? '',
      at: parsed.date?.getTime() ?? Date.now(),
      summary: text.slice(0, 200),
      text,
      unread: !parsed.headers.get('x-jiwei-seen'),
      attachments: parsed.attachments.map((a) => ({ name: a.filename ?? 'attachment', size: a.size }))
    })
  }
  return {
    uidValidity: 'fixture-1',
    lastUid: names.length ? parseInt(names.at(-1)!) : 0,
    list: async (q) =>
      mails
        .filter(
          (m) =>
            (!q.afterUid || Number(m.id.split(':').at(-1)) > q.afterUid) &&
            (!q.since || m.at >= Date.parse(q.since)) &&
            (!q.unreadOnly || m.unread) &&
            (!q.from || m.from.toLowerCase().includes(q.from.toLowerCase()))
        )
        .sort((a, b) => (q.afterUid !== undefined ? Number(a.id.split(':').at(-1)) - Number(b.id.split(':').at(-1)) : b.at - a.at))
        .slice(0, q.limit ?? 30),
    read: async (uid) => {
      const m = mails.find((m) => m.id === mailId(accountId, 'fixture-1', uid))
      if (!m) throw new Error('Mail not found')
      return m
    }
  }
}
async function withReader<T>(accountId: string, fn: (reader: MailReader) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const a = accountRow(accountId)
  const validate = (): void => {
    signal?.throwIfAborted()
    if (accountRow(accountId).updatedAt !== a.updatedAt) throw new Error('Mail account changed; run again')
  }
  if (fixtureMailEnabled()) {
    const result = await fn(await fixtureReader(accountId))
    validate()
    return result
  }
  const pass = openJson<string | null>(a.secretEnc, null)
  if (!pass) throw new Error(tr('凭证不可用，请在界面重新填写', 'Credentials are unavailable; enter them again in settings'))
  const client = new ImapFlow({
    host: a.host,
    port: a.port,
    secure: a.tls,
    ...(!a.tls ? { doSTARTTLS: true } : {}),
    auth: { user: a.username, pass },
    clientInfo: { name: 'Jiwei', version: app.getVersion() },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000
  })
  client.on('error', () => {})
  const stop = (): void => client.close()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      if (!client.mailbox) throw new Error('Mailbox unavailable')
      const validity = String(client.mailbox.uidValidity)
      const readFetched = async (m: FetchMessageObject): Promise<MailContent> => {
        if (!m.bodyStructure) throw new Error('Missing mail structure')
        const { bodies, attachments } = selectMailParts(m.bodyStructure)
        const chosen = bodies.filter((b) => b.type.toLowerCase() === 'text/plain'),
          parts = chosen.length ? chosen : bodies.filter((b) => b.type.toLowerCase() === 'text/html')
        const fetched = parts.length
          ? await client.fetchOne(
              m.uid,
              { bodyParts: parts.map((p) => ({ key: p.part || 'TEXT', maxLength: 64000 })) },
              { uid: true, binary: false }
            )
          : null
        const text = await mailBodyFromParts(parts, fetched && fetched.bodyParts ? fetched.bodyParts : new Map()),
          date = m.envelope?.date ?? m.internalDate
        return {
          id: mailId(accountId, validity, m.uid),
          accountId,
          from: m.envelope?.from?.map((f) => `${f.name ?? ''} <${f.address ?? ''}>`).join(', ') ?? '',
          subject: m.envelope?.subject ?? '',
          at: date ? new Date(date).getTime() : Date.now(),
          text,
          summary: text.slice(0, 200),
          unread: !m.flags?.has('\\Seen'),
          attachments
        }
      }
      const result = await fn({
        uidValidity: validity,
        lastUid: Math.max(0, client.mailbox.uidNext - 1),
        list: async (q) => {
          const filter: SearchObject = {
            ...(q.since ? { since: new Date(q.since) } : {}),
            ...(q.unreadOnly ? { seen: false } : {}),
            ...(q.from ? { from: q.from } : {}),
            ...(q.afterUid !== undefined ? { uid: `${q.afterUid + 1}:*` } : { all: true })
          }
          const ids = await client.search(filter, { uid: true })
          if (!Array.isArray(ids)) return []
          const sorted = ids
            .filter((u) => q.afterUid === undefined || u > q.afterUid)
            .sort((a, b) => (q.afterUid !== undefined ? a - b : b - a))
            .slice(0, q.limit ?? 30)
          const out: MailContent[] = []
          for (const uid of sorted) {
            const m = await client.fetchOne(
              uid,
              { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true },
              { uid: true }
            )
            if (m) out.push(await readFetched(m))
          }
          return out
        },
        read: async (uid) => {
          const m = await client.fetchOne(
            uid,
            { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true },
            { uid: true }
          )
          if (!m) throw new Error('Mail not found')
          return readFetched(m)
        }
      })
      validate()
      return result
    } finally {
      lock.release()
    }
  } finally {
    signal?.removeEventListener('abort', stop)
    await client.logout().catch(() => client.close())
  }
}
export async function listMail(input: MailQuery, signal?: AbortSignal): Promise<MailSummary[]> {
  const q = MailList.parse(input),
    ids = q.accountId
      ? [q.accountId]
      : accounts()
          .filter((a) => a.enabled)
          .map((a) => a.id)
  const out: MailContent[] = []
  for (const id of ids) out.push(...(await withReader(id, (r) => r.list(q), signal)))
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, q.limit)
    .map(({ text: _t, attachments: _a, ...m }) => m)
}
export async function readMail(id: string, signal?: AbortSignal): Promise<MailContent> {
  const parts = id.split(':'),
    uid = Number(parts[2])
  if (parts.length !== 3 || !Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid mail id')
  return withReader(
    parts[0],
    async (r) => {
      if (r.uidValidity !== parts[1]) throw new Error('Mailbox changed; list mail again')
      return r.read(uid)
    },
    signal
  )
}
export async function pollMail(
  accountId: string,
  validity: string | null,
  lastUid: number
): Promise<{ validity: string; lastUid: number; mails: MailContent[] }> {
  try {
    const batch = await withReader(accountId, async (r) => {
      if (!validity || validity !== r.uidValidity) return { validity: r.uidValidity, lastUid: r.lastUid, mails: [] }
      const mails = await r.list({ afterUid: lastUid, limit: 30 })
      return { validity: r.uidValidity, lastUid: mails.length ? Math.max(...mails.map((m) => Number(m.id.split(':')[2]))) : lastUid, mails }
    })
    setMailError(accountId, false)
    return batch
  } catch {
    setMailError(accountId, true)
    throw new Error('Mail polling failed; check connection settings')
  }
}
