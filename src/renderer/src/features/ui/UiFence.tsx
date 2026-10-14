import type { CustomRendererProps } from 'streamdown'
import { useUiContext } from './context'
import { UiBlock } from './UiBlock'

export function UiFence({ code, isIncomplete, meta }: CustomRendererProps) {
  const ctx = useUiContext()
  // static 模式会把上游 incomplete 置 false，停止时仍以原始围栏闭合状态为准。
  return <UiBlock raw={code} incomplete={isIncomplete || /jiwei-open=1/.test(meta ?? '')} index={ctx.fenceIndex(meta)} ctx={ctx} />
}
