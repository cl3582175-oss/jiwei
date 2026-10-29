const messages = {
  'zh-CN': {
    failed: '操作未完成',
    retained: '输入已保留，请重试或取消。',
    retry: '重试',
    working: '处理中…'
  },
  en: {
    failed: 'Could not complete the action',
    retained: 'Your input is preserved. Retry or cancel.',
    retry: 'Retry',
    working: 'Working…'
  }
}

export function confirmMessages(language: string) {
  return messages[language.startsWith('zh') ? 'zh-CN' : 'en']
}
