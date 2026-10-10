import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import type * as Y from 'yjs'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import type { DocNode, Proposal } from '@shared/types'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/utils'
import { applyInboxToEditor } from '../inbox/documents'

const text=(node:DocNode):string=>node.text??node.content?.map(text).join('')??''
/** 已关闭网页或重启后，仍由当前真实笔记编辑器确认原提案；同一事务支持撤销。 */
export function PendingVocabulary({proposal,editor,ydoc}:{proposal:Proposal;editor:Editor|null;ydoc:Y.Doc|null}) {
  const {t}=useTranslation(),qc=useQueryClient(),[busy,setBusy]=useState(false)
  const additions=proposal.ops.flatMap((op)=>op.op==='insert_row'?op.body:op.op==='insert_after'?op.nodes:[]) as DocNode[]
  const save=async():Promise<void>=>{
    if(!editor||!ydoc)return
    setBusy(true)
    const manager=yUndoPluginKey.getState(editor.state)?.undoManager,before=manager?.undoStack.length??0,redo=manager?[...manager.redoStack]:[],editable=editor.isEditable
    try {
      const source=proposal.sources?.find((source)=>source.type==='source'),word=proposal.title.replace(/^生词[：:]\s*/,''),gloss=additions[0]?text(additions[0]):'',sentence=additions[1]?text(additions[1]):''
      if(!source||!word||!gloss||!sentence)throw new Error(t('lens.errors.unapplied'))
      const target={kind:'source' as const,id:source.id},state=await api.reading.state(target)
      // prepare 重新校验持久来源和笔记的隐私；已有提案保留当初的 concept 选择。
      const landing=await api.reading.prepare({target,word,gloss,sentence,language:state.language,concept:false})
      if(landing.proposalId!==proposal.id)throw new Error(t('lens.errors.unapplied'))
      editor.setEditable(false)
      await applyInboxToEditor(editor,ydoc,proposal,(update)=>api.reading.complete(proposal.id,update))
      void qc.invalidateQueries({queryKey:['proposals',proposal.noteId]});void qc.invalidateQueries({queryKey:['notes']});void qc.invalidateQueries({queryKey:['review']});toast.success(t('reading.saved'))
    } catch(error) {
      // 完成校验拒绝时撤销刚插入的领域事务；不留下显示成功、主进程未接受的内容。
      if(manager){while(manager.undoStack.length>before)manager.undo();manager.redoStack=redo}
      toast.error(error instanceof Error?error.message:String(error))
    } finally {editor.setEditable(editable);setBusy(false)}
  }
  return <section data-testid="learning-proposal-notice" className="rounded-xl border border-border p-3 text-xs">
    <p className="font-medium">{proposal.title}</p><p className="mt-2 text-muted">{t('reading.pendingHint')}</p>
    <div className="mt-3 max-h-44 space-y-2 overflow-auto whitespace-pre-wrap break-words">{additions.map((node,index)=><p key={index}>{text(node)}</p>)}</div>
    <Button className="mt-3" size="sm" disabled={busy||!editor||!ydoc} onClick={()=>void save()}>{t('reading.confirm')}</Button>
  </section>
}
