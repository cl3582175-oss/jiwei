import { CaptureWindow } from './features/capture/CaptureWindow'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
// 内置开源字体：思源宋体（标题，按需分片加载）与霞鹜文楷（线索栏、引文点缀）
import '@fontsource-variable/noto-serif-sc'
import '@fontsource/lxgw-wenkai/500.css'
import './i18n'
import './styles/globals.css'
import { App } from './App'
import { queryClient } from './lib/queryClient'

document.documentElement.dataset.os = window.platform.os

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {new URLSearchParams(location.search).has('capture') ? <CaptureWindow /> : <App />}
    </QueryClientProvider>
  </StrictMode>
)
