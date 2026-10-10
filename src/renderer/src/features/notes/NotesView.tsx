import { useEffect } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { useApp } from '@/store/app'
import { NotesSidebar } from './NotesSidebar'
import { NoteEditor } from './NoteEditor'
import { NotesHome } from '../home/NotesHome'
import { SourcePane } from '../workspace/SourcePane'
import { BrowserPane } from '../browser/BrowserPane'
import { FloatingPanel } from '@/components/FloatingPanel'
import { CollapsibleSidebar, useSidebar } from '@/components/CollapsibleSidebar'
import { AiPanelBody, AiPanelFloat } from '../assist/AiPanel'
import { useAssist } from '../assist/store'

/**
 * 笔记工作区：侧栏 | [资料] | 笔记 | [AI 面板（钉住时）]
 * 资料栏可拖动，默认按黄金比例 0.382；AI 面板未钉住时浮在右下角。
 */
export function NotesView() {
  const { noteId, sourceId, browserOpen, sourcePaneSize, setSourcePaneSize, sourceFocus } = useApp()
  const sourceRef = usePanelRef()
  // 整理审阅需要左右两栏（转写稿 | 结果）：临时放宽资料栏并收起笔记列表；结束后回到用户自己的宽度
  const focus = sourceFocus && !browserOpen && !!sourceId
  useEffect(() => {
    sourceRef.current?.resize(focus ? '62%' : `${useApp.getState().sourcePaneSize}%`)
  }, [focus, sourceRef])
  // 左栏：浏览器优先于资料（v0.6.0）
  const left = browserOpen ? <BrowserPane /> : sourceId ? <SourcePane sourceId={sourceId} /> : null
  const pinned = useAssist((s) => s.panelOpen && s.panelPinned)
  const sidebar = useSidebar()
  // 钉住 AI 面板时收起第 2 栏，把空间留给资料与笔记
  useEffect(() => {
    if (pinned && !sidebar.collapsed) sidebar.toggle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned])
  const main = noteId ? <NoteEditor noteId={noteId} /> : <NotesHome />
  return (
    <div className="flex h-full">
      <CollapsibleSidebar forceCollapsed={focus}>
        <NotesSidebar />
      </CollapsibleSidebar>
      <FloatingPanel flushLeft>
        {left || pinned ? (
          <Group
            orientation="horizontal"
            className="h-full"
            onLayoutChanged={(layout) => layout.source && !focus && setSourcePaneSize(layout.source)}
          >
            {left && (
              <>
                <Panel id="source" panelRef={sourceRef} defaultSize={`${sourcePaneSize}%`} minSize="20%" maxSize="70%">
                  <div className="h-full" data-activity-area="source">
                    {left}
                  </div>
                </Panel>
                <Separator className="workspace-sep" />
              </>
            )}
            <Panel id="main" minSize="30%">
              <div className="h-full" data-activity-area="note">
                {main}
              </div>
            </Panel>
            {pinned && (
              <>
                <Separator className="workspace-sep" />
                <Panel id="assist" defaultSize="28%" minSize="20%" maxSize="45%">
                  <div className="h-full bg-sunken/40">
                    <AiPanelBody pinned />
                  </div>
                </Panel>
              </>
            )}
          </Group>
        ) : (
          main
        )}
        <AiPanelFloat />
      </FloatingPanel>
    </div>
  )
}
