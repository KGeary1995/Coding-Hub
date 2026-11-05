/** One display: its id and its rectangle on the Windows virtual desktop, in physical pixels. */
export interface DisplayRect { id: string; x: number; y: number; width: number; height: number }
export interface LayoutPart { id: string; x: number; y: number; width: number; height: number }
export interface ScreenLayout { width: number; height: number; parts: LayoutPart[] }

/** One display keeps the old limit; several share a larger one, so two side by side stay full size. */
const ONE = { width: 1920, height: 1200, area: Infinity };
const SEVERAL = { width: 3840, height: 2400, area: 1920 * 1200 * 2 };

/**
 * All displays as one picture, laid out as Windows arranges them: the picture is the whole virtual desktop (the
 * rectangle around every display), scaled down to fit, so a point in it maps straight to a point Windows can click
 * (SendInput's virtual-desktop coordinates). Space no display covers stays black. Sizes are even (video frames need it).
 */
export function layoutDisplays(displays: DisplayRect[]): ScreenLayout {
  if (!displays.length) return { width: 0, height: 0, parts: [] };
  const left = Math.min(...displays.map((d) => d.x)); const top = Math.min(...displays.map((d) => d.y));
  const right = Math.max(...displays.map((d) => d.x + d.width)); const bottom = Math.max(...displays.map((d) => d.y + d.height));
  const fullWidth = right - left; const fullHeight = bottom - top; const limit = displays.length > 1 ? SEVERAL : ONE;
  const scale = Math.min(1, limit.width / fullWidth, limit.height / fullHeight, Math.sqrt(limit.area / (fullWidth * fullHeight)));
  const width = Math.max(2, Math.floor(fullWidth * scale) & ~1); const height = Math.max(2, Math.floor(fullHeight * scale) & ~1);
  const sx = width / fullWidth; const sy = height / fullHeight;
  const parts = displays.map((d) => {
    const x = Math.round((d.x - left) * sx); const y = Math.round((d.y - top) * sy);
    return { id: d.id, x, y, width: Math.min(width, Math.round((d.x + d.width - left) * sx)) - x, height: Math.min(height, Math.round((d.y + d.height - top) * sy)) - y };
  });
  return { width, height, parts };
}
