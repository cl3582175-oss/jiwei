export type Highlight = { type: 'block' | 'segment'; id: string; locator?: string | null } | null
export async function resolveSourceHighlight(highlight: Highlight, resolve: (id: string) => Promise<string | null>): Promise<Highlight> {
  if (!highlight || highlight.type !== 'segment' || !highlight.id) return highlight
  const id = await resolve(highlight.id).catch(() => null)
  return { ...highlight, id: id ?? '' }
}
