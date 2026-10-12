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
  return (readyAt === index ? Promise.resolve() : Promise.race([ready, new Promise<void>((r) => setTimeout(r, 8000))]))
    .then(() => seekClip(t))
    .then(frame)
}

/** 数学动画片段：每一帧把视频定位到场景内的时间 t，等解码完成再截图；超过片段长度就停在最后一帧 */
async function seekClip(t: number): Promise<void> {
  const v = document.querySelector<HTMLVideoElement>('video[data-clip]')
  if (!v) return
  // 片段加载不出来时（不应发生）最多等 3 秒，不能卡住整段录制
  if (v.readyState < 1)
    await Promise.race([
      new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true })),
      new Promise((r) => setTimeout(r, 3000))
    ])
  if (v.readyState < 1) return
  const target = Math.min(t, Math.max(0, v.duration - 0.02))
  if (Math.abs(v.currentTime - target) < 0.004 && v.readyState >= 2) return
  await Promise.race([
    new Promise((r) => {
      v.addEventListener('seeked', r, { once: true })
      v.currentTime = target
    }),
    new Promise((r) => setTimeout(r, 2000))
  ])
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
