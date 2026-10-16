import { useEffect, useRef } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useApp } from '@/store/app'
import { useNoteLayout } from './noteBar'
import { FloatingPanel } from '@/components/FloatingPanel'
import { cn } from '@/lib/utils'
import { BrowserPane } from './BrowserPane'
import { NoteEditor } from '../notes/NoteEditor'
import { AiPanelBody, AiPanelFloat } from '../assist/AiPanel'
import { usePanel } from '../assist/store'

// 浏览器工作区（v0.7.2）：从「浏览」进入时浏览器独占整页；点“记笔记”新建或打开一篇笔记，
// 浏览器与笔记分栏显示（不显示笔记分类与搜索栏）。笔记栏在左 / 右 / 上 / 下由用户选择，分隔条可拖动，都会记住。

export function BrowserWorkspace() {
  const browserNote = useApp((s) => s.browserNote)
  const panel = usePanel()
  const pinned = panel.open && panel.pinned
  const { side, size, save } = useNoteLayout()
  const vertical = side === 'top' || side === 'bottom'
  const noteFirst = side === 'left' || side === 'top'
  const saveTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  const browser = (
    <div className="h-full" data-activity-area="source">
      <BrowserPane />
    </div>
  )
  const note = browserNote ? (
    <div className="h-full" data-activity-area="note" data-testid="browser-note">
      <NoteEditor key={browserNote} noteId={browserNote} />
    </div>
  ) : null

  const split = note ? (
    <Group
      key={side}
      orientation={vertical ? 'vertical' : 'horizontal'}
      className="h-full"
      onLayoutChanged={(layout) => {
        const n = layout.note
        if (!n || Math.abs(n - size) < 0.5) return
        window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => save({ noteSize: Math.round(n * 10) / 10 }), 400)
      }}
    >
      {noteFirst && (
        <>
          <Panel id="note" defaultSize={`${size}%`} minSize="15%" maxSize="85%">
            {note}
          </Panel>
          <Separator className={cn('workspace-sep', vertical && 'workspace-sep-h')} />
        </>
      )}
      <Panel id="browser" minSize="15%">
        {browser}
      </Panel>
      {!noteFirst && (
        <>
          <Separator className={cn('workspace-sep', vertical && 'workspace-sep-h')} />
          <Panel id="note" defaultSize={`${size}%`} minSize="15%" maxSize="85%">
            {note}
          </Panel>
        </>
      )}
    </Group>
  ) : (
    browser
  )

  return (
    <FloatingPanel>
      <div className="h-full" data-testid="browser-workspace" data-side={note ? side : 'none'}>
        {pinned ? (
          <Group orientation="horizontal" className="h-full">
            <Panel id="work" minSize="40%">
              {split}
            </Panel>
            <Separator className="workspace-sep" />
            <Panel id="assist" defaultSize="28%" minSize="20%" maxSize="45%">
              <div className="h-full bg-sunken/40">
                <AiPanelBody pinned />
              </div>
            </Panel>
          </Group>
        ) : (
          split
        )}
      </div>
      <AiPanelFloat />
    </FloatingPanel>
  )
}
