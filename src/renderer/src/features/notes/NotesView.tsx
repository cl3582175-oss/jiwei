import { Group, Panel, Separator } from 'react-resizable-panels'
import { useApp } from '@/store/app'
import { NotesSidebar } from './NotesSidebar'
import { NoteEditor } from './NoteEditor'
import { NotesHome } from '../home/NotesHome'
import { SourcePane } from '../workspace/SourcePane'
import { FloatingPanel } from '@/components/FloatingPanel'
import { CollapsibleSidebar } from '@/components/CollapsibleSidebar'

/** 笔记工作区：侧栏 | [资料] | 笔记（资料栏可拖动，默认按黄金比例 0.382） */
export function NotesView() {
  const { noteId, sourceId, sourcePaneSize, setSourcePaneSize } = useApp()
  const main = noteId ? <NoteEditor noteId={noteId} /> : <NotesHome />
  return (
    <div className="flex h-full">
      <CollapsibleSidebar>
        <NotesSidebar />
      </CollapsibleSidebar>
      <FloatingPanel flushLeft>
        {sourceId ? (
          <Group
            orientation="horizontal"
            className="h-full"
            onLayoutChanged={(layout) => layout.source && setSourcePaneSize(layout.source)}
          >
            <Panel id="source" defaultSize={`${sourcePaneSize}%`} minSize="20%" maxSize="70%">
              <SourcePane sourceId={sourceId} />
            </Panel>
            <Separator className="workspace-sep" />
            <Panel id="main" minSize="30%">
              {main}
            </Panel>
          </Group>
        ) : (
          main
        )}
      </FloatingPanel>
    </div>
  )
}
