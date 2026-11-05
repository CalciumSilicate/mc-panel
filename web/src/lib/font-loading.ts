/** Fonts are bundled and self-hosted; no remote stylesheet or persistent readiness flag. */
export async function loadNotoSansScFullFont(): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return false
  try {
    const faces = await document.fonts.load('400 14px "Noto Sans SC Variable"', '正在加载页面')
    return faces.length > 0
  } catch { return false }
}
export function isNotoSansScFullFontReady(): boolean {
  return typeof document !== 'undefined' && document.fonts.check('400 14px "Noto Sans SC Variable"', '正在加载页面')
}
export const isNotoSansScFullFontActive = isNotoSansScFullFontReady
export function activateNotoSansScFullFont() { /* Self-hosted CSS declares the family from first paint. */ }
