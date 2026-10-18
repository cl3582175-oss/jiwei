import { Streamdown, type StreamdownProps } from 'streamdown'
import { useExpandedPresentation } from '@/components/ui/ExpandableSurface'
import { markdownControls } from './presentation'

/** Read presentation here, inside the live portal, rather than outside UiFrame's provider. */
export function UiMarkdown({ controls, className, ...props }: StreamdownProps) {
  const { expanded } = useExpandedPresentation()
  // Streamdown 2.7's memo comparator omits controls. A presentation class updates its
  // provider without changing its key or remounting the live Markdown/table subtree.
  const presentationClass = expanded ? [className, 'ui-markdown-expanded'].filter(Boolean).join(' ') : className
  return <Streamdown {...props} className={presentationClass} controls={markdownControls(controls, expanded)} />
}
