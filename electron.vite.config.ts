import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), worker: resolve('src/worker/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // browser：内置浏览器网页中的内容脚本（v0.6.0）
        input: { index: resolve('src/preload/index.ts'), browser: resolve('src/preload/browser.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src'), ...shared }
    },
    plugins: [react(), tailwindcss()]
  }
})
