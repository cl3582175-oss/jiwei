import { resolve } from 'path'
import { execFileSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'verified-word-frequency',
        buildStart: () => {
          execFileSync(process.execPath, [resolve('scripts/build-wordfreq.mjs')], { stdio: 'inherit' })
        }
      }
    ],
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
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        // scene：讲解视频的离屏录制页（v0.9）
        input: { index: resolve('src/renderer/index.html'), scene: resolve('src/renderer/scene.html') }
      }
    }
  }
})
