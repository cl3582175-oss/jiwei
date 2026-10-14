import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { compileExpression } from '@shared/embeds/graph'
import type { VideoScene } from '@shared/works'

// 讲解视频的场景（v0.9）：画面完全由时间 t（秒）决定——同一个 t 永远是同一帧。
// 应用内预览和离屏录制共用这个组件；异步渲染的内容（Mermaid、ECharts、JSXGraph）就绪后调用 onReady。

export const STAGE_W = 1280
export const STAGE_H = 720

import { mix, type Tokens } from '@/features/visuals/tokens'
import { decorateDiagram, mermaidThemeVariables } from '@/features/visuals/mermaidTheme'

const C = {
  paper: '#FBFCFA',
  ink: '#1F2523',
  muted: '#6B746F',
  accent: '#2F6F62',
  soft: '#E7F0EC',
  line: '#DCE3DF',
  // 与应用里的图表同一套分类色（--viz-1…4 的浅色版本），视频固定浅底
  series: ['#2f6fb3', '#d9682b', '#1f9a8a', '#c94540']
}
/** 视频里示意图的配色：固定浅色主题，规则与应用内示意图相同（按角色上色） */
const VIDEO_TOKENS: Tokens = (() => {
  const viz = ['#2f6fb3', '#d9682b', '#1f9a8a', '#c94540', '#7a5cc2', '#b07d0a', '#d0527a', '#3d7f2a']
  return {
    accent: C.accent,
    accentFg: '#ffffff',
    fg: C.ink,
    muted: C.muted,
    subtle: '#9aa39e',
    border: C.line,
    borderStrong: '#c6d0cb',
    surface: '#ffffff',
    sunken: '#f1f4f2',
    danger: '#c0473a',
    dark: '',
    p1: '',
    p2: '',
    p3: '',
    p4: '',
    p5: '',
    emph: viz[1],
    rest: '#c9cfcc',
    viz,
    vizSoft: viz.map((v) => mix(v, '#ffffff', 0.14))
  }
})()
const SANS = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", -apple-system, sans-serif'
const SERIF = '"Songti SC", "Noto Serif CJK SC", Georgia, serif'

/** 平滑过渡：t 在 [start, start + dur] 内从 0 到 1 */
export const ease = (t: number, start: number, dur: number): number => {
  const x = Math.min(1, Math.max(0, (t - start) / dur))
  return x * x * (3 - 2 * x)
}
const enter = (p: number, dy = 18): CSSProperties => ({ opacity: p, transform: `translateY(${(1 - p) * dy}px)` })

interface Props {
  scene: VideoScene
  t: number
  duration: number
  caption?: string
  onReady?: () => void
}

export function SceneView({ scene, t, duration, caption, onReady }: Props) {
  const ready = useRef(onReady)
  ready.current = onReady
  const sync = !['diagram', 'chart', 'graph', 'animation'].includes(scene.template)
  useEffect(() => {
    if (sync) ready.current?.()
  }, [scene, sync])
  const done = (): void => ready.current?.()
  return (
    <div
      style={{
        width: STAGE_W,
        height: STAGE_H,
        background: C.paper,
        color: C.ink,
        fontFamily: SANS,
        position: 'relative',
        overflow: 'hidden'
      }}
      data-scene={scene.template}
    >
      {scene.template === 'title' ? (
        <TitleScene scene={scene} t={t} />
      ) : (
        <>
          <Heading text={scene.title} t={t} />
          {/* 文字类模板在内容区垂直居中，避免画面上重下空 */}
          <div
            style={{
              position: 'absolute',
              left: 96,
              right: 96,
              top: 170,
              bottom: 120,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: ['bullets', 'summary', 'formula', 'quote'].includes(scene.template) ? 'center' : 'stretch'
            }}
          >
            <Body scene={scene} t={t} duration={duration} onReady={done} />
          </div>
        </>
      )}
      {caption && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 34,
            transform: 'translateX(-50%)',
            maxWidth: 1040,
            padding: '10px 22px',
            borderRadius: 12,
            background: 'rgba(31,37,35,0.78)',
            color: '#fff',
            fontSize: 26,
            lineHeight: 1.45,
            textAlign: 'center'
          }}
          data-caption
        >
          {caption}
        </div>
      )}
    </div>
  )
}

function Heading({ text, t }: { text: string; t: number }) {
  if (!text) return null
  const p = ease(t, 0, 0.5)
  return (
    <div style={{ position: 'absolute', left: 96, top: 72, right: 96, display: 'flex', alignItems: 'center', gap: 18, ...enter(p, 10) }}>
      <span style={{ width: 8, height: 48, background: C.accent, borderRadius: 2 }} />
      <span style={{ fontFamily: SERIF, fontSize: 46, fontWeight: 700, letterSpacing: 1 }}>{text}</span>
    </div>
  )
}

function TitleScene({ scene, t }: { scene: Extract<VideoScene, { template: 'title' }>; t: number }) {
  const bar = ease(t, 0, 0.7)
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 26,
          background: C.accent,
          transform: `scaleY(${bar})`,
          transformOrigin: 'top'
        }}
      />
      <div style={{ position: 'absolute', left: 130, right: 130, top: 250 }}>
        <div style={{ fontFamily: SERIF, fontSize: 72, fontWeight: 700, lineHeight: 1.2, ...enter(ease(t, 0.2, 0.8), 24) }}>
          {scene.title}
        </div>
        {scene.subtitle && (
          <div style={{ marginTop: 28, fontSize: 30, color: C.muted, ...enter(ease(t, 0.7, 0.7), 16) }}>{scene.subtitle}</div>
        )}
      </div>
    </>
  )
}

/** 列表类模板：在 [start, end] 内依次出现 */
const stagger = (n: number, duration: number, i: number): number => {
  const start = 0.5,
    end = Math.max(start + 0.6, duration * 0.7)
  return start + (n <= 1 ? 0 : ((end - start) * i) / n)
}

function Body({ scene, t, duration, onReady }: { scene: VideoScene; t: number; duration: number; onReady: () => void }): ReactNode {
  switch (scene.template) {
    case 'bullets':
    case 'summary': {
      const n = scene.items.length
      const current = scene.items.reduce((c, _, i) => (t >= stagger(n, duration, i) ? i : c), -1)
      return (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 26 }}>
          {scene.items.map((item, i) => {
            const p = ease(t, stagger(n, duration, i), 0.45)
            const check = scene.template === 'summary'
            return (
              <li
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 24,
                  fontSize: 42,
                  lineHeight: 1.35,
                  opacity: p,
                  transform: `translateX(${(1 - p) * -28}px)`
                }}
              >
                {check ? (
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 17,
                      border: `3px solid ${C.accent}`,
                      background: p > 0.9 ? C.accent : 'transparent',
                      color: '#fff',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 22,
                      flexShrink: 0
                    }}
                  >
                    {p > 0.9 ? '✓' : ''}
                  </span>
                ) : (
                  <span
                    style={{ width: 12, height: 12, background: i === current ? C.accent : C.line, flexShrink: 0, transition: 'none' }}
                  />
                )}
                <span style={{ color: i === current || check ? C.ink : C.muted }}>{item}</span>
              </li>
            )
          })}
        </ul>
      )
    }
    case 'formula': {
      const n = scene.steps.length
      const span = Math.max(0.6, duration * 0.8 - 0.4)
      const at = (i: number): number => 0.4 + (span * i) / Math.max(1, n)
      const current = scene.steps.reduce((c, _, i) => (t >= at(i) ? i : c), 0)
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {scene.steps.map((tex, i) => {
            const p = ease(t, at(i), 0.5)
            return (
              <div
                key={i}
                style={{
                  fontSize: 40,
                  padding: '12px 26px',
                  borderLeft: `5px solid ${i === current ? C.accent : 'transparent'}`,
                  background: i === current ? C.soft : 'transparent',
                  borderRadius: 8,
                  opacity: p * (i === current ? 1 : 0.45),
                  ...enter(p, 12)
                }}
                dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { throwOnError: false, displayMode: false }) }}
              />
            )
          })}
        </div>
      )
    }
    case 'compare': {
      const col = (side: 'left' | 'right', start: number) => {
        const d = scene[side]
        const p = ease(t, start, 0.6)
        return (
          <div
            style={{ flex: 1, borderRadius: 20, background: side === 'left' ? C.soft : '#F4ECE7', padding: '28px 34px', ...enter(p, 20) }}
          >
            <div style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 700, color: side === 'left' ? C.accent : '#B4654A' }}>{d.title}</div>
            <ul style={{ margin: '18px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {d.items.map((x, i) => (
                <li key={i} style={{ fontSize: 28, lineHeight: 1.4, opacity: ease(t, start + 0.3 + i * 0.25, 0.4) }}>
                  · {x}
                </li>
              ))}
            </ul>
          </div>
        )
      }
      return (
        <div style={{ display: 'flex', gap: 36, height: '100%' }}>
          {col('left', 0.4)}
          {col('right', Math.max(1.2, duration * 0.4))}
        </div>
      )
    }
    case 'quote': {
      const chars = [...scene.quote]
      const shown = Math.ceil(chars.length * ease(t, 0.4, Math.max(1, duration * 0.6)))
      return (
        <div style={{ position: 'relative', paddingLeft: 70, paddingTop: 20 }}>
          <span style={{ position: 'absolute', left: 0, top: -30, fontFamily: SERIF, fontSize: 140, color: C.accent, opacity: 0.25 }}>
            “
          </span>
          <div style={{ fontFamily: SERIF, fontSize: 44, lineHeight: 1.55 }}>
            {chars.slice(0, shown).join('')}
            <span style={{ opacity: 0 }}>{chars.slice(shown).join('')}</span>
          </div>
          {scene.by && (
            <div style={{ marginTop: 28, fontSize: 26, color: C.muted, opacity: ease(t, Math.max(1, duration * 0.65), 0.5) }}>
              —— {scene.by}
            </div>
          )}
        </div>
      )
    }
    case 'diagram':
      return (
        <Wipe t={t}>
          <Mermaid code={scene.code} onReady={onReady} />
        </Wipe>
      )
    case 'chart':
      return (
        <Wipe t={t}>
          <Chart scene={scene} onReady={onReady} />
        </Wipe>
      )
    case 'graph':
      return (
        <Wipe t={t}>
          <FunctionGraph scene={scene} onReady={onReady} />
        </Wipe>
      )
    case 'animation':
      return <AnimationClip scene={scene} onReady={onReady} />
    default:
      return null
  }
}

const ANIMATION_NAME = { derivation: '公式推导', 'function-transform': '函数变换', 'number-line': '数轴与区间', geometry: '几何作图' }
/** 数学动画（v0.10）：录制时由主进程渲染好片段（data URI），录制页逐帧定位到 t；应用内预览还没有片段时显示占位 */
function AnimationClip({ scene, onReady }: { scene: Extract<VideoScene, { template: 'animation' }>; onReady: () => void }) {
  const clip = (scene as { clip?: string }).clip
  useEffect(() => {
    if (!clip) onReady()
  }, [clip, onReady])
  if (!clip)
    return (
      <div
        style={{
          height: '100%',
          borderRadius: 18,
          border: `2px dashed ${C.line}`,
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
          color: C.muted,
          fontSize: 30,
          lineHeight: 1.6
        }}
      >
        <div>
          <div style={{ color: C.accent, fontSize: 38 }}>{ANIMATION_NAME[scene.animation.kind]}</div>
          数学动画在渲染视频时生成
        </div>
      </div>
    )
  return (
    <video
      data-clip
      src={clip}
      muted
      playsInline
      preload="auto"
      onLoadedData={onReady}
      style={{ width: '100%', height: '100%', objectFit: 'contain', background: C.paper }}
    />
  )
}

/** 从左到右擦出（图示、图表、函数图） */
function Wipe({ t, children }: { t: number; children: ReactNode }) {
  const p = ease(t, 0.3, 1.4)
  return (
    <div style={{ width: '100%', height: '100%', clipPath: `inset(0 ${(1 - p) * 100}% 0 0)`, opacity: Math.min(1, p * 3) }}>{children}</div>
  )
}

let mermaidSeq = 0
function Mermaid({ code, onReady }: { code: string; onReady: () => void }) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: 'base',
          fontFamily: SANS,
          themeVariables: mermaidThemeVariables(VIDEO_TOKENS, '22px')
        })
        const decorated = await decorateDiagram(code, mermaid, VIDEO_TOKENS)
        const out = await mermaid
          .render(`scene-mermaid-${++mermaidSeq}`, decorated)
          .catch(() => mermaid.render(`scene-mermaid-${++mermaidSeq}`, code))
        // Mermaid 自带 max-width（原始尺寸），视频里要按比例撑满内容区
        const fit = out.svg
          .replace(/style="max-width:[^"]*"/, 'style="width:100%;height:100%"')
          .replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" ')
        if (alive) setSvg(fit)
      } catch {
        if (alive) setSvg('')
      }
      if (alive) requestAnimationFrame(onReady)
    })()
    return () => {
      alive = false
    }
  }, [code]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center' }}
      className="scene-svg-fit"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function Chart({ scene, onReady }: { scene: Extract<VideoScene, { template: 'chart' }>; onReady: () => void }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let chart: { dispose(): void } | null = null
    let alive = true
    void import('echarts').then((echarts) => {
      if (!alive || !el.current) return
      const c = echarts.init(el.current, undefined, { renderer: 'svg' })
      chart = c
      const pie = scene.kind === 'pie'
      c.setOption({
        animation: false,
        color: C.series,
        textStyle: { fontFamily: SANS, fontSize: 20, color: C.ink },
        legend: scene.series.length > 1 || pie ? { top: 0, textStyle: { fontSize: 20, color: C.muted } } : undefined,
        grid: { left: 70, right: 30, top: scene.series.length > 1 ? 60 : 20, bottom: 50 },
        ...(pie
          ? {
              series: [
                {
                  type: 'pie',
                  radius: ['38%', '70%'],
                  label: { fontSize: 22, color: C.ink },
                  data: scene.categories.map((name, i) => ({ name, value: scene.series[0].data[i] ?? 0 }))
                }
              ]
            }
          : {
              xAxis: {
                type: 'category',
                data: scene.categories,
                axisLabel: { fontSize: 20, color: C.muted },
                axisLine: { lineStyle: { color: C.line } }
              },
              yAxis: { type: 'value', axisLabel: { fontSize: 18, color: C.muted }, splitLine: { lineStyle: { color: C.line } } },
              series: scene.series.map((s) => ({
                type: scene.kind,
                name: s.name,
                data: s.data,
                barMaxWidth: 64,
                lineStyle: { width: 4 },
                symbolSize: 10,
                smooth: false
              }))
            })
      })
      requestAnimationFrame(onReady)
    })
    return () => {
      alive = false
      chart?.dispose()
    }
  }, [scene]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} style={{ width: '100%', height: '100%' }} />
}

function FunctionGraph({ scene, onReady }: { scene: Extract<VideoScene, { template: 'graph' }>; onReady: () => void }) {
  const id = useMemo(() => `scene-graph-${Math.random().toString(36).slice(2)}`, [])
  useEffect(() => {
    let board: unknown = null
    let jxg: {
      JSXGraph: {
        initBoard(id: string, a: Record<string, unknown>): { create(t: string, p: unknown[], a?: Record<string, unknown>): unknown }
        freeBoard(b: unknown): void
      }
    } | null = null
    let alive = true
    void import('jsxgraph').then((mod) => {
      if (!alive) return
      jxg = ((mod as { default?: unknown }).default ?? mod) as typeof jxg
      const [x0, x1, y0, y1] = scene.view
      // 四周留边：视窗贴着坐标轴时（如 x 从 0 开始），刻度数字落在边界外会被裁掉
      const dx = (x1 - x0) * 0.08,
        dy = (y1 - y0) * 0.1
      const b = jxg!.JSXGraph.initBoard(id, {
        boundingbox: [x0 - dx, y1 + dy, x1 + dx, y0 - dy],
        axis: false,
        showCopyright: false,
        showNavigation: false,
        pan: { enabled: false },
        zoom: { enabled: false }
      })
      board = b
      const axis = (label: Record<string, unknown>) => ({
        strokeColor: C.muted,
        strokeWidth: 2,
        ticks: { strokeColor: C.line, drawLabels: true, label: { strokeColor: C.muted, fontSize: 20, display: 'internal', ...label } }
      })
      // x 轴数字在轴下方居中，y 轴数字在轴左侧右对齐，不压在轴线上
      b.create(
        'axis',
        [
          [0, 0],
          [1, 0]
        ],
        axis({ anchorX: 'middle', anchorY: 'top', offset: [0, -10] })
      )
      b.create(
        'axis',
        [
          [0, 0],
          [0, 1]
        ],
        axis({ anchorX: 'right', anchorY: 'middle', offset: [-10, 0] })
      )
      scene.functions.forEach((expr, i) => {
        try {
          const run = compileExpression(expr, ['x'])
          b.create(
            'curve',
            [
              (x: number) => x,
              (x: number) => {
                const y = run({ x })
                return Number.isFinite(y) ? y : NaN
              },
              x0,
              x1
            ],
            { strokeColor: C.series[i % C.series.length], strokeWidth: 4, highlight: false }
          )
        } catch {
          /* 非法表达式：不画这条 */
        }
      })
      requestAnimationFrame(onReady)
    })
    return () => {
      alive = false
      if (board && jxg) jxg.JSXGraph.freeBoard(board)
    }
  }, [scene, id]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div id={id} className="jxgbox" style={{ width: '100%', height: '100%' }} />
}

/* ——— 时间轴：每个场景的时长与字幕 ——— */

export interface SceneTiming {
  start: number
  duration: number
  /** 字幕：相对场景开头的时间 */
  captions: { start: number; end: number; text: string }[]
}

/** 把整段时间 T 定位到场景与场景内时间 */
export function locate(timings: SceneTiming[], T: number): { index: number; t: number; caption: string } {
  let index = timings.findIndex((s) => T < s.start + s.duration)
  if (index < 0) index = timings.length - 1
  const s = timings[index]
  const t = Math.max(0, T - s.start)
  const caption = s.captions.find((c) => t >= c.start && t < c.end)?.text ?? ''
  return { index, t, caption }
}
