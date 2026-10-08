import type { SVGProps } from 'react'

// 水墨线描插画：线条用 currentColor（随主题变化），点缀用配色变量，适配所有配色与深色模式。
// 风格约定：1.6 线宽、圆头、少量粉彩填色、一枚小印章。

type P = SVGProps<SVGSVGElement> & { size?: number }

const base = (size: number, w = 160, h = 120): SVGProps<SVGSVGElement> => ({
  width: size,
  height: (size * h) / w,
  viewBox: `0 0 ${w} ${h}`,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
})

/** 小印章（朱文） */
function Seal({ x, y, s = 9 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={s} height={s} rx={1.6} fill="var(--accent)" stroke="none" opacity={0.9} />
      <path
        d={`M${s * 0.3} ${s * 0.3}h${s * 0.4}M${s * 0.5} ${s * 0.3}v${s * 0.42}M${s * 0.3} ${s * 0.72}h${s * 0.4}`}
        stroke="var(--accent-fg)"
        strokeWidth={0.9}
      />
    </g>
  )
}

/** 笔记：摊开的书页与一支毛笔 */
export function InkNotes({ size = 160, ...rest }: P) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M22 88c18-6 36-6 58 2 22-8 40-8 58-2" opacity={0.35} />
      <path d="M24 34c18-6 36-5 56 4v50c-20-9-38-10-56-4z" fill="var(--paper)" />
      <path d="M136 34c-18-6-36-5-56 4v50c20-9 38-10 56-4z" fill="var(--paper)" />
      <path d="M34 48c10-2 20-1 32 3M34 58c10-2 20-1 30 3M34 68c8-2 16-1 24 2" opacity={0.45} />
      <path d="M92 50c12-4 22-4 32-2M92 60c10-3 20-3 30-1" opacity={0.45} />
      <rect x={92} y={66} width={22} height={10} rx={3} fill="var(--p-bamboo)" stroke="none" />
      <path d="M118 18l-34 58" strokeWidth={2.2} />
      <path d="M84 76c-3 4-3 8-1 10 3-1 5-5 5-9" fill="var(--fg)" stroke="none" opacity={0.85} />
      <Seal x={126} y={92} />
    </svg>
  )
}

/** 资料库：书架上的几本书 */
export function InkLibrary({ size = 160, ...rest }: P) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M18 92h124" />
      <rect x={34} y={42} width={14} height={50} rx={2} fill="var(--p-apricot)" />
      <rect x={50} y={34} width={12} height={58} rx={2} fill="var(--p-sky)" />
      <rect x={64} y={48} width={16} height={44} rx={2} fill="var(--p-sakura)" />
      <path d="M86 92l14-46 12 4-14 46z" fill="var(--p-bamboo)" />
      <path d="M38 52h6M54 44h4M68 58h8" opacity={0.5} />
      <path d="M120 92c0-10 4-18 10-22M126 92c0-12 6-22 14-26M130 76c4-2 8-2 10 0" opacity={0.55} />
      <path d="M116 92h20l-2 10h-16z" fill="var(--paper)" />
      <Seal x={22} y={100} />
    </svg>
  )
}

/** 最近删除：一片飘落的银杏叶 */
export function InkLeaf({ size = 160, ...rest }: P) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M30 40c20-6 34 2 50-4M44 62c14-4 26 2 38-2" opacity={0.25} />
      <path d="M78 74c-14-4-24-18-20-32 10 2 18 8 22 16 4-10 12-18 24-20 2 16-8 30-24 36z" fill="var(--p-gosling)" />
      <path d="M80 74l6 22" />
      <path d="M70 52c4 6 7 12 9 20M96 50c-6 6-10 14-12 22" opacity={0.45} />
      <path d="M40 100c22 4 52 4 84-2" opacity={0.3} />
      <Seal x={126} y={92} />
    </svg>
  )
}

/** 搜索无结果：远山与一轮月 */
export function InkMountains({ size = 160, ...rest }: P) {
  return (
    <svg {...base(size)} {...rest}>
      <circle cx={116} cy={34} r={10} fill="var(--p-gosling)" />
      <path d="M14 92c18-22 30-34 44-34 12 0 20 16 30 16 10 0 18-24 34-24 12 0 18 22 26 42z" fill="var(--p-sky)" opacity={0.85} />
      <path d="M8 98c26-14 44-20 62-18 20 2 30 10 52 8 10-1 20-4 30-8" fill="var(--p-bamboo)" />
      <path d="M40 72c6-2 10-6 14-12M96 64c4-4 8-10 12-16" opacity={0.45} />
      <Seal x={138} y={100} />
    </svg>
  )
}

/** 欢迎页主图：青绿山水的层叠山峦与初升的太阳 */
export function InkWelcome({ size = 360, ...rest }: P) {
  return (
    <svg {...base(size, 360, 180)} strokeWidth={1.4} {...rest}>
      <circle cx={262} cy={58} r={18} fill="var(--accent)" stroke="none" opacity={0.85} />
      <path d="M0 132c40-30 70-56 104-56 30 0 44 30 70 30 28 0 44-58 84-58 34 0 60 44 102 84v48H0z" fill="var(--p-sky)" stroke="none" />
      <path d="M0 150c50-26 86-36 124-34 40 2 62 20 104 18 40-2 78-18 132-30v76H0z" fill="var(--p-bamboo)" stroke="none" />
      <path d="M0 168c60-14 120-20 180-14s120 4 180-8v34H0z" fill="var(--panel)" stroke="none" opacity={0.9} />
      <path d="M104 76c-10 10-16 22-18 36M258 48c-12 14-20 30-22 50" opacity={0.35} />
      <path d="M40 120c14-8 26-12 40-12M196 128c18-6 36-8 52-6" opacity={0.3} />
      <path d="M150 40c6-2 12-2 18 0M300 92c5-2 10-2 15 0" opacity={0.35} />
    </svg>
  )
}
