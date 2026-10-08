import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/** 保存完成时盖一枚小印章：从“保存中”变为“已保存”的瞬间轻轻落下再淡出 */
export function SaveSeal({ saving }: { saving: boolean }) {
  const { t } = useTranslation()
  const was = useRef(saving)
  const [stamp, setStamp] = useState(0)
  useEffect(() => {
    if (was.current && !saving) setStamp((n) => n + 1)
    was.current = saving
  }, [saving])
  if (!stamp) return null
  return (
    <span
      key={stamp}
      className={cn(
        'ml-2 inline-grid h-4 place-items-center rounded-[3px] bg-accent px-1 align-middle font-display text-[10px] leading-none text-accent-fg',
        'animate-[seal-stamp_1600ms_ease-out_forwards]'
      )}
    >
      {t('celebrate.saved')}
    </span>
  )
}
