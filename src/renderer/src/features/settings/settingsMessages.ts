const zh = {
  failed: '未能保存设置',
  retained: '当前页面和未保存的内容已保留。请重试，或继续编辑后再离开。',
  retry: '重试保存',
  edit: '继续编辑',
  discard: '丢弃并离开',
  discardTitle: '丢弃未保存的修改？',
  discardDescription: '尚未保存的草稿会被丢弃；已经成功保存的数据会保留。',
  saving: '正在保存设置…',
  nameRequired: '请输入名字（最多 60 个字符）',
  amountInvalid: '请输入 0 到 100000000 之间的金额，留空表示不限。',
  rateInvalid: '请输入大于 0 且不超过 10000000 的汇率。',
  portInvalid: '端口必须是 1024 到 65535 之间的整数。',
  keepInvalid: '保留数量必须是 1 到 100 之间的整数。'
}
const en: typeof zh = {
  failed: 'Settings could not be saved',
  retained: 'This page and your unsaved changes are still here. Retry, or continue editing before leaving.',
  retry: 'Retry save',
  edit: 'Continue editing',
  discard: 'Discard and leave',
  discardTitle: 'Discard unsaved changes?',
  discardDescription: 'Unsaved drafts will be discarded. Changes already saved successfully will be kept.',
  saving: 'Saving settings…',
  nameRequired: 'Enter a name (up to 60 characters)',
  amountInvalid: 'Enter an amount between 0 and 100000000, or leave blank for no limit.',
  rateInvalid: 'Enter a rate greater than 0 and no more than 10000000.',
  portInvalid: 'Enter a whole-number port from 1024 to 65535.',
  keepInvalid: 'Enter a whole-number retention count from 1 to 100.'
}
export const settingsMessages = (language: string): typeof zh => (language.startsWith('zh') ? zh : en)
