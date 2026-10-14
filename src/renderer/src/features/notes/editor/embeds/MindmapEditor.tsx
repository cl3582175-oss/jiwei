import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog as D } from 'radix-ui'
import * as Y from 'yjs'
import MindElixir, { type MindElixirInstance } from 'mind-elixir'
import 'mind-elixir/style.css'
import { en, zh_CN } from 'mind-elixir/i18n'
import { MindmapDataSchema, toTree, type MindmapData } from '@shared/embeds/mindmap'
import { fromElixir, toElixir } from '@shared/embeds/mindElixir'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/primitives'
import { toY } from './ydata'

// 思维导图编辑：mind-elixir（MIT）。显示仍用 markmap（只读、轻量），点“编辑”时在大窗口中编辑。
// 数据保持积微自己的扁平模型；节点的原文锚点、备注放在 mind-elixir 的 metadata 中，编辑后原样带回。

/** 以界面配色生成 mind-elixir 主题 */
function theme(): NonNullable<ConstructorParameters<typeof MindElixir>[0]['theme']> {
  const css = getComputedStyle(document.documentElement)
  const v = (k: string, f: string): string => css.getPropertyValue(k).trim() || f
  const accent = v('--accent', '#3d8a74')
  const dark = document.documentElement.dataset.theme === 'dark'
  return {
    name: 'jiwei',
    type: dark ? 'dark' : 'light',
    // 每条主干一种分类色（与图表、示意图同一套 --viz-*），层级和分支一眼能分开
    palette: Array.from({ length: 8 }, (_, i) => v(`--viz-${i + 1}`, accent)),
    cssVar: {
      '--main-color': v('--fg', '#222'),
      '--main-bgcolor': v('--surface', '#fff'),
      '--color': v('--fg', '#222'),
      '--bgcolor': v('--paper', v('--surface', '#fafaf8')),
      '--selected': accent,
      '--accent-color': accent,
      '--root-color': v('--accent-fg', '#fff'),
      '--root-bgcolor': accent,
      '--root-border-color': 'transparent',
      '--panel-color': v('--fg', '#222'),
      '--panel-bgcolor': v('--surface', '#fff'),
      '--panel-border-color': v('--border', '#ddd')
    }
  } as never
}

export function MindmapEditorDialog({
  entry,
  open,
  onOpenChange
}: {
  entry: Y.Map<unknown>
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const el = useRef<HTMLDivElement | null>(null)
  const mind = useRef<MindElixirInstance | null>(null)
  const [ready, setReady] = useState(false)

  // 对话框内容挂载后再初始化（Radix 使用 Portal）
  const mount = (node: HTMLDivElement | null): void => {
    el.current = node
    setReady(!!node)
  }

  useEffect(() => {
    if (!open || !ready || !el.current) return
    const raw = (entry.get('data') as { toJSON(): unknown } | undefined)?.toJSON?.()
    const parsed = MindmapDataSchema.safeParse(raw)
    const tree = parsed.success ? toTree(parsed.data) : null
    if (!tree) return
    const m = new MindElixir({
      el: el.current,
      direction: MindElixir.RIGHT,
      editable: true,
      contextMenu: { locale: i18n.language.startsWith('zh') ? zh_CN : en },
      toolBar: true,
      keypress: true,
      allowUndo: true,
      newTopicName: t('embeds.newTopic'),
      theme: theme()
    })
    m.init(toElixir(tree) as never)
    mind.current = m
    return () => {
      m.destroy?.()
      mind.current = null
    }
  }, [open, ready, entry, i18n.language, t])

  const save = (): void => {
    const m = mind.current
    if (!m) return onOpenChange(false)
    const data = fromElixir(m.getData() as never)
    const doc = entry.doc
    const write = (): void => {
      entry.set('data', toY(data))
    }
    if (doc) doc.transact(write)
    else write()
    onOpenChange(false)
  }

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(86vh,820px)] w-[min(94vw,1280px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-float outline-none"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
            <D.Title className="font-serif text-md font-semibold text-fg">{t('embeds.editMindmap')}</D.Title>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
              <span>
                <Kbd>Tab</Kbd> {t('embeds.keyChild')}
              </span>
              <span>
                <Kbd>Enter</Kbd> {t('embeds.keySibling')}
              </span>
              <span>
                <Kbd>F2</Kbd> {t('embeds.keyEdit')}
              </span>
              <span>
                <Kbd>Del</Kbd> {t('embeds.keyDelete')}
              </span>
            </span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" onClick={save}>
              {t('common.save')}
            </Button>
          </header>
          <div ref={mount} className="mindmap-editor min-h-0 flex-1" data-testid="mindmap-editor" />
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 供测试：把嵌套 Y 数据读成普通对象 */
export const readMindmap = (entry: Y.Map<unknown>): MindmapData | null => {
  const r = MindmapDataSchema.safeParse((entry.get('data') as { toJSON(): unknown } | undefined)?.toJSON?.())
  return r.success ? r.data : null
}
