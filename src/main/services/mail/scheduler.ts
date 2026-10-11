import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../../db'
import { mailSeen, meta, jobs } from '../../db/schema'
import { listTasks, queueTask } from '../tasks/service'
import { pollMail } from './imap'

/** 同一账户只推进一次游标，先扇出到所有匹配任务，再提交游标，避免首个任务消费其他任务的邮件。 */
export async function checkMailTriggers(now: number): Promise<void> {
  const grouped = new Map<string, ReturnType<typeof listTasks>>()
  for (const t of listTasks())
    if (t.enabled && t.trigger.type === 'mail') grouped.set(t.trigger.accountId, [...(grouped.get(t.trigger.accountId) ?? []), t])
  for (const [accountId, tasks] of grouped) {
    const key = `mail.poll:${accountId}`,
      last = Number(getDb().select().from(meta).where(eq(meta.key, key)).get()?.value ?? 0)
    if (now - last < 300000) continue
    // 手动运行尚未结束时不丢弃增量批次，留给下一次轮询。
    if (
      tasks.some((t) =>
        getDb()
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.dedupeKey, `task:${t.id}`), sql`${jobs.status} IN ('running','queued')`))
          .get()
      )
    )
      continue
    try {
      const old = getDb()
        .select()
        .from(mailSeen)
        .where(and(eq(mailSeen.accountId, accountId), eq(mailSeen.mailbox, 'INBOX')))
        .get()
      const batch = await pollMail(accountId, old?.uidValidity ?? null, old?.lastUid ?? 0)
      getDb().transaction(() => {
        for (const t of tasks) {
          if (t.trigger.type !== 'mail') continue
          const trigger = t.trigger,
            matches = batch.mails.filter(
              (m) =>
                (!trigger.from || m.from.toLowerCase().includes(trigger.from.toLowerCase())) &&
                (!trigger.subjectContains || m.subject.toLowerCase().includes(trigger.subjectContains.toLowerCase()))
            )
          if (matches.length) queueTask(t.id, { type: 'mail', accountId, mailIds: matches.map((m) => m.id) })
        }
        getDb()
          .insert(mailSeen)
          .values({ accountId, mailbox: 'INBOX', uidValidity: batch.validity, lastUid: batch.lastUid })
          .onConflictDoUpdate({
            target: [mailSeen.accountId, mailSeen.mailbox],
            set: { uidValidity: batch.validity, lastUid: batch.lastUid }
          })
          .run()
      })
    } catch {
      // 账号状态保存通用错误；下一次五分钟轮询再尝试，不把认证错误写进日志。
    }
    getDb()
      .insert(meta)
      .values({ key, value: String(now) })
      .onConflictDoUpdate({ target: meta.key, set: { value: String(now) } })
      .run()
  }
}
