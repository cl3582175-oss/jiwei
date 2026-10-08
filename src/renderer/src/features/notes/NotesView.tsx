import { useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useApp } from '@/store/app'
import { NotesSidebar } from './NotesSidebar'
import { NoteEditor } from './NoteEditor'
import { NotesHome } from '../home/NotesHome'
import { SourcePane } from '../workspace/SourcePane'
import { FloatingPanel } from '@/components/FloatingPanel'
import { CollapsibleSidebar, useSidebar } from '@/components/CollapsibleSidebar'
import { AiPanelBody, AiPanelFloat } from '../assist/AiPanel'
import { useAssist } from '../assist/store'

/**
 * 笔记工作区：侧栏 | [资料] | 笔记 | [AI 面板（钉住时）]
 * 资料栏可拖动，默认按黄金比例 0.382；AI 面板未钉住时浮在右下角。
 */
export function NotesView() {
  const { noteId, sourceId, sourcePaneSize, setSourcePaneSize } = useApp()
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
      <CollapsibleSidebar>
        <NotesSidebar />
      </CollapsibleSidebar>
      <FloatingPanel flushLeft>
        {sourceId || pinned ? (
          <Group
            orientation="horizontal"
            className="h-full"
            onLayoutChanged={(layout) => layout.source && setSourcePaneSize(layout.source)}
          >
            {sourceId && (
              <>
                <Panel id="source" defaultSize={`${sourcePaneSize}%`} minSize="20%" maxSize="70%">
                  <SourcePane sourceId={sourceId} />
                </Panel>
                <Separator className="workspace-sep" />
              </>
            )}
            <Panel id="main" minSize="30%">
              {main}
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
