import { eq, isNull } from 'drizzle-orm'
import { MailSave, MAIL_PRESETS, type MailAccount, type MailInput } from '@shared/mail'
import { getDb } from '../../db'
import { mailAccounts, mailSeen } from '../../db/schema'
import { emit } from '../../events'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { tr } from '../../lib/messages'
import { sealJson } from '../mcp/secrets'
import { listMail } from './imap'

type Row = typeof mailAccounts.$inferSelect
export const mailChanged = (): void => emit('mail:changed', {})
function info(r: Row): MailAccount {
  return {
    id: r.id,
    name: r.name,
    preset: r.preset as MailAccount['preset'],
    host: r.host,
    port: r.port,
    tls: r.tls,
    username: r.username,
    secretSet: !!r.secretEnc,
    enabled: r.enabled,
    lastError: r.lastError
  }
}
export function accountRow(id: string): Row {
  const r = getDb().select().from(mailAccounts).where(eq(mailAccounts.id, id)).get()
  if (!r || r.deletedAt || !r.enabled) throw new Error(tr('邮箱不可用或已停用', 'Mail account is unavailable or disabled'))
  return r
}
export function accounts(): MailAccount[] {
  return getDb().select().from(mailAccounts).where(isNull(mailAccounts.deletedAt)).all().map(info)
}
export function saveAccount(input: MailInput): MailAccount {
  const v = MailSave.parse(input),
    old = v.id ? getDb().select().from(mailAccounts).where(eq(mailAccounts.id, v.id)).get() : undefined
  if (v.id && (!old || old.deletedAt)) throw new Error('Mail account not found')
  const secretEnc = v.secret === undefined || v.secret === '' ? (old?.secretEnc ?? null) : sealJson(v.secret)
  if (!secretEnc) throw new Error(tr('请填写邮箱授权码或应用专用密码', 'Enter a mail authorization code or app password'))
  const id = v.id ?? newId(),
    now = Date.now(),
    host = v.preset === 'custom' ? v.host : MAIL_PRESETS[v.preset].host
  const row = {
    name: v.name,
    preset: v.preset,
    host,
    port: v.preset === 'custom' ? v.port : 993,
    tls: v.preset === 'custom' ? v.tls : true,
    username: v.username,
    secretEnc,
    enabled: v.enabled,
    lastError: null,
    updatedAt: now,
    updatedBy: deviceId()
  }
  getDb().transaction(() => {
    if (old) getDb().update(mailAccounts).set(row).where(eq(mailAccounts.id, id)).run()
    else
      getDb()
        .insert(mailAccounts)
        .values({ ...row, id, createdAt: now })
        .run()
    if (old && (old.host !== host || old.username !== v.username || old.port !== row.port || old.tls !== row.tls))
      getDb().delete(mailSeen).where(eq(mailSeen.accountId, id)).run()
  })
  mailChanged()
  return info(getDb().select().from(mailAccounts).where(eq(mailAccounts.id, id)).get()!)
}
export function removeAccount(id: string): void {
  getDb().transaction(() => {
    getDb()
      .update(mailAccounts)
      .set({ secretEnc: null, enabled: false, deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId() })
      .where(eq(mailAccounts.id, id))
      .run()
    getDb().delete(mailSeen).where(eq(mailSeen.accountId, id)).run()
  })
  mailChanged()
}
export function setMailError(id: string, failed: boolean): void {
  getDb()
    .update(mailAccounts)
    .set({
      lastError: failed
        ? tr('连接失败，请检查地址、授权码和邮箱设置', 'Connection failed; check address, app password and mailbox settings')
        : null
    })
    .where(eq(mailAccounts.id, id))
    .run()
  mailChanged()
}
export async function testAccount(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    await listMail({ accountId: id, limit: 1 })
    setMailError(id, false)
    return { ok: true, message: tr('连接成功（只读）', 'Connected (read-only)') }
  } catch {
    setMailError(id, true)
    return { ok: false, message: tr('连接失败，请检查邮箱设置', 'Connection failed; check mailbox settings') }
  }
}
