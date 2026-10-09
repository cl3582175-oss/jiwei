import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { conversations } from '../db/schema'
import { loadSkill } from './ai/skills'
import { getReflection, reflectionMaterial, reflectionText } from './reflection'

// 复盘追问：一个 kind = reflection 的对话，AI 按技能 reflection-coach 一次问一个问题。
// 素材包在第一轮生成后固定在系统提示中（便于缓存）；复盘正文会随着用户书写变化，所以每轮放在用户消息里。

export interface CoachMeta {
  reflectionId: string
  /** 素材包文字（第一轮生成后固定） */
  material?: string
  title?: string
}

export function ensureCoachMaterial(conversationId: string, meta: CoachMeta): CoachMeta {
  if (meta.material !== undefined) return meta
  const r = getReflection(meta.reflectionId)
  let material = ''
  try {
    material = reflectionMaterial(meta.reflectionId).text
  } catch {
    /* 复盘已删除：没有素材 */
  }
  const next = { ...meta, material, title: r?.title ?? '' }
  getDb()
    .update(conversations)
    .set({ meta: JSON.stringify(next) })
    .where(eq(conversations.id, conversationId))
    .run()
  return next
}

export function coachSystem(meta: CoachMeta, zh: boolean): string {
  return [
    loadSkill('reflection-coach', zh),
    `${zh ? '本次复盘' : 'This reflection'}：${meta.title ?? ''}`,
    `<${zh ? '素材包' : 'material'}>\n${meta.material || (zh ? '（这段时间没有学习记录）' : '(no records)')}\n</${zh ? '素材包' : 'material'}>`,
    zh ? '始终用简体中文，像对话一样说话。' : 'Always answer in English, conversationally.'
  ].join('\n\n')
}

export function coachTurn(meta: CoachMeta, text: string, zh: boolean): string {
  const body = reflectionText(meta.reflectionId)
  return `<${zh ? '当前复盘' : 'current reflection'}>\n${body || (zh ? '（还没写）' : '(empty)')}\n</${zh ? '当前复盘' : 'current reflection'}>\n\n${zh ? '用户' : 'User'}：${text}`
}
