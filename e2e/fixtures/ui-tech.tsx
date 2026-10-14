import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Streamdown, type CustomRendererProps } from 'streamdown'

// P0 最小页面：只观测上游真实行为，不接产品数据或服务商。
const Sequence = createContext<() => number>(() => -1)
let instance = 0
const observations: { instance: number; index: number; code: string; incomplete: boolean }[] = []
const mounts: number[] = []
const unmounts: number[] = []

function Fence({ code, isIncomplete }: CustomRendererProps) {
  const allocate = useContext(Sequence)
  const [identity] = useState(() => ++instance)
  const index = allocate()
  useEffect(() => {
    mounts.push(identity)
    return () => {
      unmounts.push(identity)
    }
  }, [identity])
  useEffect(() => {
    observations.push({ instance: identity, index, code, incomplete: isIncomplete })
  }, [identity, index, code, isIncomplete])
  return (
    <pre data-instance={identity} data-index={index} data-incomplete={isIncomplete}>
      {code}
    </pre>
  )
}
const plugins = { renderers: [{ language: 'jiwei-ui', component: Fence }] }

declare global {
  interface Window {
    uiProbe: {
      setText(text: string): void
      observations: typeof observations
      mounts: number[]
      unmounts: number[]
    }
  }
}

function Probe() {
  const [text, setText] = useState('')
  const count = useRef(0)
  count.current = 0
  window.uiProbe = { setText, observations, mounts, unmounts }
  return (
    <Sequence.Provider value={() => count.current++}>
      <Streamdown mode="streaming" isAnimating plugins={plugins}>
        {text}
      </Streamdown>
    </Sequence.Provider>
  )
}
createRoot(document.getElementById('root')!).render(<Probe />)
