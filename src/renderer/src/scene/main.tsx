import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { VideoScene } from '@shared/works'
import { SceneView, locate, type SceneTiming } from './SceneView'

// 离屏录制页（v0.9）：主进程注入分镜与时间轴，逐帧调用 seek(T)，每次等画面就绪后截取。

interface Data {
  scenes: VideoScene[]
  timings: SceneTiming[]
}

const root = createRoot(document.getElementById('stage')!)
let data: Data | null = null
let shown = -1
let readyAt = -1
let waiters: (() => void)[] = []

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

function render(T: number): Promise<void> {
  const { index, t, caption } = locate(data!.timings, T)
  const scene = data!.scenes[index]
  const changed = index !== shown
  shown = index
  const ready = changed
    ? new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    : Promise.resolve()
  flushSync(() =>
    root.render(
      <SceneView
        key={scene.id}
        scene={scene}
        t={t}
        duration={data!.timings[index].duration}
        caption={caption}
        onReady={() => {
          readyAt = index
          const list = waiters
          waiters = []
          list.forEach((w) => w())
        }}
      />
    )
  )
  // 异步内容（Mermaid、ECharts、JSXGraph）最多等 8 秒，避免一处失败卡住整段录制
  return (readyAt === index ? Promise.resolve() : Promise.race([ready, new Promise<void>((r) => setTimeout(r, 8000))])).then(frame)
}

declare global {
  interface Window {
    jiweiScene: { load(d: Data): Promise<void>; seek(T: number): Promise<void> }
  }
}
window.jiweiScene = {
  async load(d) {
    data = d
    shown = -1
    readyAt = -1
    await document.fonts.ready
    await render(0)
  },
  seek: (T) => render(T)
}
