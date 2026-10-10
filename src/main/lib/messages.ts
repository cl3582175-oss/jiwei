/** 主进程面向用户的提示语言。由设置读取时同步；纯函数模块（lib）也能用，不依赖数据库。 */
let language: 'zh' | 'en' = 'zh'
export function setMessageLanguage(value: string | undefined): void {
  if (value) language = value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
export const tr = (zh: string, en: string): string => (language === 'zh' ? zh : en)
