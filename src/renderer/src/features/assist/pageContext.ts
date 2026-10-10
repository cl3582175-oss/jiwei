import { useEffect } from 'react'
import { create } from 'zustand'

/**
 * 当前页面给积微助手侧栏的上下文（v0.6.7）：在「今日」、复习、错题等页面按 ⌘J 提问时，助手知道你在看什么。
 * 只放这个页面已经显示给用户的简短文字，不放“不给 AI”或“仅本地”的内容。
 */
export interface PageContext {
  title: string
  text: string
}
export const usePageContext = create<{ page: PageContext | null }>(() => ({ page: null }))

export function useProvidePageContext(page: PageContext | null): void {
  const title = page?.title,
    text = page?.text
  useEffect(() => {
    usePageContext.setState({ page: title && text ? { title, text: text.slice(0, 4000) } : null })
    return () => usePageContext.setState({ page: null })
  }, [title, text])
}
