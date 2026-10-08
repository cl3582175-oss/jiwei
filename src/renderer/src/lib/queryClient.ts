import { QueryClient } from '@tanstack/react-query'

/** 全局查询客户端（组件外的操作，如就地提问，也需要更新缓存） */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } }
})
