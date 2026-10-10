import { getSettings } from './settings'

const messages = {
  missing: ['错题不存在或已删除', 'Mistake not found or deleted'],
  processing: ['正在识别错题', 'Recognizing mistakes'],
  variants: ['补充错题变式', 'Preparing mistake variants'],
  canceled: ['错题任务已取消', 'Mistake task canceled'],
  localOnly: ['这道题设为仅本地，显示原题', 'This question is local only; showing the original'],
  unapplied: ['提案尚未完整写入笔记，请重试', 'The proposal has not been fully applied; please retry'],
  changed: ['错题内容已变化，请重新准备提案', 'The question changed; prepare the proposal again'],
  noModel: ['还没有设置 AI 模型', 'No AI model configured'],
  wrongVariant: ['这道变式题不存在或已被标记有误', 'This variant is missing or has been flagged'],
  landing: ['加入错题笔记', 'Add to mistake notebook'],
  deleting: ['删除错题行', 'Remove mistake row'],
  moving: ['移动错题到对应学科', 'Move mistake to its subject'],
  movingWait: ['请先完成错题移动或删除提案', 'Complete the move or removal proposal first'],
  image: ['不支持的题图格式', 'Unsupported question image'],
  notReady: ['识别尚未完成，请稍后重试', 'Recognition is still running; try again shortly'],
  unverified: ['请先核对 AI 答案，再自动出变式题', 'Verify the AI answer before generating variants']
} as const
export function mistakeText(key: keyof typeof messages): string { return messages[key][getSettings().language.startsWith('zh') ? 0 : 1] }
