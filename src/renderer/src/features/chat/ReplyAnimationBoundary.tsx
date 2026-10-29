import { Component, type ReactNode, type RefObject } from 'react'

interface Props {
  animating: boolean
  root: RefObject<HTMLDivElement | null>
  children: ReactNode
}

interface SelectionBookmark {
  anchor: number
  focus: number
}

function bookmark(root: HTMLElement): SelectionBookmark | null {
  const selection = root.ownerDocument.getSelection()
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  )
    return null
  const offset = (node: Node, end: number): number => {
    const range = root.ownerDocument.createRange()
    range.selectNodeContents(root)
    range.setEnd(node, end)
    return range.toString().length
  }
  return { anchor: offset(selection.anchorNode, selection.anchorOffset), focus: offset(selection.focusNode, selection.focusOffset) }
}

function textPoint(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (target <= offset + length) return { node, offset: target - offset }
    offset += length
  }
  return null
}

/** Snapshot before React removes temporary character spans, then restore before paint. */
export class ReplyAnimationBoundary extends Component<Props, Record<string, never>, SelectionBookmark | null> {
  getSnapshotBeforeUpdate(previous: Props): SelectionBookmark | null {
    const root = this.props.root.current
    return previous.animating && !this.props.animating && root ? bookmark(root) : null
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: SelectionBookmark | null): void {
    const root = this.props.root.current
    if (!root || !snapshot) return
    const anchor = textPoint(root, snapshot.anchor)
    const focus = textPoint(root, snapshot.focus)
    if (anchor && focus) root.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  }

  render(): ReactNode {
    return this.props.children
  }
}
