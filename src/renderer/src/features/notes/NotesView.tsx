import { useEffect } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { useApp } from '@/store/app'
import { NotesSidebar } from './NotesSidebar'
import { NoteEditor } from './NoteEditor'
import { NotesHome } from '../home/NotesHome'
import { SourcePane } from '../workspace/SourcePane'
import { BrowserWorkspace } from '../browser/BrowserWorkspace'
import { FloatingPanel } from '@/components/FloatingPanel'
import { PageSidebar, useWindowWidth } from '@/components/PageSidebar'
import { useNoteFilterLabel } from './filterLabel'
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
  // 左栏：资料（浏览器自 v0.7.2 起是独立工作区）
  const left = !browserOpen && sourceId ? <SourcePane sourceId={sourceId} /> : null
  const pinned = useAssist((s) => s.panelOpen && s.panelPinned)
  const windowWidth = useWindowWidth()
  const filterLabel = useNoteFilterLabel()
  // 空间不够时自动收成书脊（不改用户设置）：整理审阅、钉住 AI 面板、资料与笔记并排而窗口较窄
  const cramped = focus || pinned || windowWidth < 1100 || (!!left && windowWidth < 1280)
  const main = noteId ? <NoteEditor noteId={noteId} /> : <NotesHome />
  // 浏览器（v0.7.2）：独立工作区，不显示笔记分类与搜索栏；笔记按需出现在浏览器旁边
  if (browserOpen) return <BrowserWorkspace />
  return (
    <div className="flex h-full">
      <PageSidebar page="notes" auto={cramped} label={filterLabel}>
        <NotesSidebar />
      </PageSidebar>
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
