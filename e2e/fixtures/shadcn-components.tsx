import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/renderer/src/i18n'
import { Button } from '../../src/renderer/src/components/ui/shadcn-button'
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tip,
  TooltipProvider
} from '../../src/renderer/src/components/ui/shadcn-primitives'
import { confirm, prompt, DialogHost } from '../../src/renderer/src/components/ui/shadcn-confirm'
import { Composer } from '../../src/renderer/src/features/chat/Composer'
import { Segmented } from '../../src/renderer/src/components/ui/segmented'
import '../../src/renderer/src/styles/globals.css'

// This fixture mounts the production exports and has no API bridge, database,
// provider, production route or pretend mutation. App-path evidence lives in the
// Electron cases. Only platform identity is supplied by the HTML host.
export interface ShadcnProbe {
  refs(): { button: boolean; input: boolean; selection: [number | null, number | null] }
  focusInput(): void
  setLanguage(language: string): Promise<unknown>
  startPrompt(): void
  enqueue(): void
  abortable(): void
  abort(): void
  unmountHost(): void
  setSendMode(mode: 'success' | 'reject' | 'deferred'): void
  finishSend(): void
  sends: string[]
  results: unknown[]
}

declare global {
  interface Window {
    shadcnProbe: ShadcnProbe
  }
}

function Probe() {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('初始值')
  const [submits, setSubmits] = useState(0)
  const [host, setHost] = useState(true)
  const [choice, setChoice] = useState<'first' | 'second'>('first')
  const results = useRef<unknown[]>([])
  const controller = useRef<AbortController | null>(null)
  const sends = useRef<string[]>([])
  const sendMode = useRef<'success' | 'reject' | 'deferred'>('success')
  const finishSend = useRef<(() => void) | null>(null)
  window.shadcnProbe = {
    refs: () => ({
      button: buttonRef.current instanceof HTMLButtonElement,
      input: inputRef.current instanceof HTMLInputElement,
      selection: [inputRef.current?.selectionStart ?? null, inputRef.current?.selectionEnd ?? null]
    }),
    focusInput: () => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(1, 3)
    },
    setLanguage: (language) => i18n.changeLanguage(language),
    startPrompt: () => {
      void prompt({ title: '真实 prompt 合约', defaultValue: '初始名称', placeholder: '输入名称', confirmText: '确认名称' }).then((v) =>
        results.current.push(v)
      )
    },
    enqueue: () => {
      void confirm({ title: 'FIFO 第一项', description: '先结算第一项', confirmText: '确认第一项' }).then((v) =>
        results.current.push(['first', v])
      )
      void confirm({ title: 'FIFO 第二项', description: '再结算第二项', confirmText: '确认第二项' }).then((v) =>
        results.current.push(['second', v])
      )
    },
    abortable: () => {
      controller.current = new AbortController()
      const options: Parameters<typeof confirm>[0] & { signal: AbortSignal } = {
        title: '可取消的请求',
        signal: controller.current.signal
      }
      void confirm(options).then((v) => results.current.push(['abort', v]))
    },
    abort: () => controller.current?.abort(),
    unmountHost: () => setHost(false),
    setSendMode: (mode) => {
      sendMode.current = mode
    },
    finishSend: () => finishSend.current?.(),
    sends: sends.current,
    results: results.current
  }
  return (
    <TooltipProvider>
      <main className="min-h-screen space-y-6 bg-bg p-6 text-fg">
        <h1>Production component contract fixture</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setSubmits((v) => v + 1)
          }}
          className="flex items-center gap-2"
        >
          <Button ref={buttonRef} data-testid="default-button">
            默认按钮
          </Button>
          <Button size="sm" data-testid="small-button">
            小按钮
          </Button>
          <Button size="icon" aria-label="图标按钮" data-testid="icon-button">
            ＋
          </Button>
          <Button size="icon-sm" aria-label="小图标按钮" data-testid="small-icon-button">
            ＋
          </Button>
          <Button variant="primary" type="submit">
            明确提交
          </Button>
          <Button variant="danger" disabled>
            不可用危险操作
          </Button>
          <Button variant="danger">危险操作</Button>
          <Button variant="outline">显式描边</Button>
          <Button variant="ghost">透明按钮</Button>
          <output data-testid="form-submits">{submits}</output>
        </form>
        <section className="max-w-md space-y-3">
          <label htmlFor="controlled-input">受控字段</label>
          <Input id="controlled-input" ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} />
          <label htmlFor="uncontrolled-input">非受控字段</label>
          <Input id="uncontrolled-input" defaultValue="默认文字" />
          <label htmlFor="number-input">数值字段</label>
          <Input id="number-input" type="number" min={1} max={10} defaultValue={2} />
          <label htmlFor="date-input">日期字段</label>
          <Input id="date-input" type="date" defaultValue="2026-10-23" />
          <label htmlFor="file-input">文件字段</label>
          <Input id="file-input" type="file" accept=".txt" />
        </section>
        <Dialog>
          <DialogTrigger asChild>
            <Button>打开真实 Dialog</Button>
          </DialogTrigger>
          <DialogContent title="真实 Dialog" description="使用真实的生产组件">
            <label htmlFor="dialog-input">弹层字段</label>
            <Input id="dialog-input" />
            <Menu>
              <MenuTrigger asChild>
                <Button>对话框内菜单</Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem>对话框菜单动作</MenuItem>
              </MenuContent>
            </Menu>
          </DialogContent>
        </Dialog>
        <Menu>
          <MenuTrigger asChild>
            <Button>打开真实菜单</Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem>普通动作</MenuItem>
            <MenuSub>
              <MenuSubTrigger>嵌套菜单</MenuSubTrigger>
              <MenuSubContent>
                <MenuItem>子菜单动作</MenuItem>
              </MenuSubContent>
            </MenuSub>
            <MenuItem danger>危险动作</MenuItem>
          </MenuContent>
        </Menu>
        <Tip label="真实提示" side="top">
          <Button aria-label="提示入口">提示入口</Button>
        </Tip>
        <section aria-label="真实 Composer 合约" className="max-w-xl">
          <Composer
            busy={false}
            placeholder="真实 Composer 输入"
            onStop={() => {}}
            onSend={async (text) => {
              sends.current.push(text)
              if (sendMode.current === 'reject') return false
              if (sendMode.current === 'deferred')
                await new Promise<void>((done) => {
                  finishSend.current = done
                })
              return true
            }}
          />
        </section>
        <section aria-label="真实 Segmented 合约">
          <Segmented
            label="真实单选"
            value={choice}
            onChange={setChoice}
            options={[
              { value: 'first', label: '第一选择' },
              { value: 'second', label: '第二选择' }
            ]}
          />
          <output data-testid="segmented-choice">{choice}</output>
        </section>
        {host && <DialogHost />}
      </main>
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Probe />)
