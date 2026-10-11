import { z } from 'zod'
export const MAIL_PRESETS = {
  qq: { host: 'imap.qq.com', help: 'https://service.mail.qq.com/detail/0/75' },
  '163': { host: 'imap.163.com', help: 'https://help.mail.163.com/' },
  '126': { host: 'imap.126.com', help: 'https://help.mail.163.com/' },
  gmail: { host: 'imap.gmail.com', help: 'https://support.google.com/accounts/answer/185833' },
  icloud: { host: 'imap.mail.me.com', help: 'https://support.apple.com/102654' }
} as const
export const MailSave = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  preset: z.enum(['qq', '163', '126', 'gmail', 'icloud', 'custom']),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-z\d.-]+$/i),
  port: z.number().int().min(1).max(65535).default(993),
  tls: z.boolean().default(true),
  username: z.string().trim().min(1).max(320),
  secret: z.string().max(2000).optional(),
  enabled: z.boolean().default(true)
})
export type MailInput = z.input<typeof MailSave>
export interface MailAccount {
  id: string
  name: string
  preset: z.infer<typeof MailSave>['preset']
  host: string
  port: number
  tls: boolean
  username: string
  secretSet: boolean
  enabled: boolean
  lastError: string | null
}
export const MailList = z.object({
  accountId: z.string().min(1).optional(),
  since: z.iso.datetime().optional(),
  unreadOnly: z.boolean().optional(),
  from: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(30).default(30)
})
export type MailQuery = z.input<typeof MailList>
export interface MailSummary {
  id: string
  accountId: string
  from: string
  subject: string
  at: number
  summary: string
  unread: boolean
}
export interface MailContent extends MailSummary {
  text: string
  attachments: { name: string; size: number }[]
}
