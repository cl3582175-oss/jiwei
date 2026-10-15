export const notePrivacyZh = {
  notePrivacyAttachmentOnly: '含有未归档的对话附件，只在那个对话里能用。归档附件后自动解除。',
  notePrivacyLockUser: '你设置了不发送给 AI',
  digestTargetRedirect: '目标笔记现在不能由 AI 写入，结果会放进一篇新笔记。',
  digestRedirected: '原来的笔记不能写入了，结果已放进新笔记《{title}》。',
  aiOutputTruncated: '模型写到输出上限还没写完（其中思考占 {pct}%），加大上限重试后仍未完成。',
  aiIdleTimeout: '模型超过 {sec} 秒没有任何输出，已中断。'
}
export const notePrivacyEn: Record<keyof typeof notePrivacyZh, string> = {
  notePrivacyAttachmentOnly:
    'Contains unarchived chat attachments, so it can only be used in that conversation. Archiving them lifts this automatically.',
  notePrivacyLockUser: 'You chose not to send this to AI',
  digestTargetRedirect: "The target note can't be written by AI right now, so the result will go into a new note.",
  digestRedirected: 'The original note can no longer be written, so the result is in the new note "{title}".',
  aiOutputTruncated: 'The model hit its output limit before finishing ({pct}% was thinking), even after retrying with a larger limit.',
  aiIdleTimeout: 'The model produced no output for {sec} seconds and was stopped.'
}
