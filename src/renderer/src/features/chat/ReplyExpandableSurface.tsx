import { useContext, useEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { ExpandableSurface, useExpandedPresentation } from '@/components/ui/ExpandableSurface'
import { ReplySelectionContext, useReplySelection } from '../assist/replySelection'
import { SelectionToolbar } from '../assist/SelectionToolbar'
import { useAssist } from '../assist/store'

/** Keep MessageItem's text-selection affordances inside the same modal and permission boundary. */
export function ReplyExpandableSurface(props: ComponentProps<typeof ExpandableSurface>) {
  return (
    <ExpandableSurface {...props}>
      <ReplySelectionScope>{props.children}</ReplySelectionScope>
    </ExpandableSurface>
  )
}

function ReplySelectionScope({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const reply = useContext(ReplySelectionContext)
  const { expanded } = useExpandedPresentation()
  useReplySelection(root, expanded && !!reply?.messageId)
  useEffect(() => {
    if (!expanded || !reply?.messageId) return
    return () => {
      const { toolbar, showToolbar } = useAssist.getState()
      if (toolbar?.anchor.parentType === 'message' && toolbar.anchor.parentId === reply.messageId) showToolbar(null)
    }
  }, [expanded, reply?.messageId])
  return (
    <div
      ref={root}
      className="reply-surface-content"
      data-expanded-reply={expanded && reply?.messageId ? '' : undefined}
      data-reply-id={expanded ? reply?.messageId : undefined}
      data-conversation-id={expanded ? reply?.conversationId : undefined}
      data-streaming={reply?.streaming ? 'true' : undefined}
      data-reply-restricted={reply?.restricted ? 'true' : undefined}
    >
      {children}
      {expanded && reply?.messageId && <SelectionToolbar scope={root} />}
    </div>
  )
}
