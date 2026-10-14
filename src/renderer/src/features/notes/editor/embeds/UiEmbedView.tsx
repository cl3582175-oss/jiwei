import { useTranslation } from 'react-i18next'
import * as Y from 'yjs'
import { UiEmbedSchema } from '@shared/ui/catalog'
import { UI_DEFAULTS } from '@shared/ui/settings'
import type { Citation } from '@shared/types'
import { useSettings } from '@/lib/queries'
import { UiNodeView } from '@/features/ui/UiNodeView'
import type { UiContext, UiState } from '@/features/ui/context'
import { registerEmbedView, type EmbedViewProps } from './registry'
import { toY } from './ydata'

const record = (v: unknown): UiState => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UiState) : {})
function View({ entry, id, editable }: EmbedViewProps) {
  const { t, i18n } = useTranslation(),
    { data: settings } = useSettings()
  const data = entry.get('data')
  const parsed = UiEmbedSchema.safeParse(data instanceof Y.Map ? data.toJSON() : data)
  if (!parsed.success) return <p className="px-4 py-3 text-xs text-danger">{t('ui.failed')}</p>
  const value = parsed.data,
    state = record(value.state),
    descendants = record(state.descendants)
  const states = { [id]: state, ...Object.fromEntries(Object.entries(descendants).map(([key, val]) => [`${id}.${key}`, record(val)])) }
  const ctx: UiContext = {
    messageId: value.from?.messageId ?? id,
    conversationId: value.from?.conversationId ?? '',
    isLatest: false,
    streaming: false,
    stopped: !editable,
    compact: false,
    context: 'note',
    settings: settings?.ai.ui ?? UI_DEFAULTS,
    citations: Array.isArray(state.citations)
      ? state.citations.filter(
          (c): c is Citation =>
            !!c &&
            typeof c === 'object' &&
            ['note', 'source', 'web'].includes(c.parentType) &&
            typeof c.n === 'number' &&
            typeof c.parentId === 'string' &&
            typeof c.ownerId === 'string' &&
            typeof c.title === 'string' &&
            typeof c.snippet === 'string'
        )
      : [],
    states,
    fenceIndex: () => 0,
    setState: (key, patch) => {
      if (!editable || !(data instanceof Y.Map)) return
      const write = (): void => {
        let root = data.get('state')
        if (!(root instanceof Y.Map)) {
          root = toY(state)
          data.set('state', root)
        }
        let target = root as Y.Map<unknown>
        if (key !== id) {
          let children = target.get('descendants')
          if (!(children instanceof Y.Map)) {
            children = toY(descendants)
            target.set('descendants', children)
          }
          const path = key.slice(id.length + 1)
          let child = (children as Y.Map<unknown>).get(path)
          if (!(child instanceof Y.Map)) {
            child = toY(record(descendants[path]))
            ;(children as Y.Map<unknown>).set(path, child)
          }
          target = child as Y.Map<unknown>
        }
        for (const [name, val] of Object.entries(patch)) target.set(name, toY(val))
        if ('snapshot' in patch) data.set('savedAt', Date.now())
      }
      if (entry.doc) entry.doc.transact(write)
    }
  }
  return (
    <div data-testid="ui-note-embed" className="min-w-0 text-fg">
      {value.node.title && <p className="px-4 pt-3 text-sm font-medium">{value.node.title}</p>}
      {typeof state.snapshot === 'string' && (
        <p className="px-4 pt-2 text-2xs text-subtle">{t('ui.asOf', { date: new Date(value.savedAt).toLocaleString(i18n.language) })}</p>
      )}
      <UiNodeView node={value.node} uiKey={id} ctx={ctx} />
    </div>
  )
}
registerEmbedView({ kind: 'ui', label: 'embeds.ui', View })
