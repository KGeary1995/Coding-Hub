import { useEffect, type RefObject } from 'react';
import { terminalDimensions } from '../../runtime/terminals';
import { useHubStore } from '../../state/hub-store';

/** One terminal line's height in px (to a hundredth), from the screen xterm sizes to a whole number of lines; null while it is not drawn. */
export const terminalRow = (screenHeight: number, rows: number) => screenHeight > 0 && rows > 0 ? Math.round(screenHeight / rows * 100) / 100 : null;

/**
 * Keeps --tr-term-row on a channel's tile at its terminal's line height, which tile.css needs to end what lies over the
 * terminal's top (the detail row, a request strip) where a line ends. The height follows the font size in Settings and
 * the display scale, so it is measured: when the screen's size changes, and when the font size does (more lines of a
 * smaller size can make the same height), or the laptop switch changes the size drawn.
 */
export function useTerminalRow(tile: RefObject<HTMLElement>, sessionId: string, on: boolean) {
  const fontSize = useHubStore((state) => state.preferences.terminalFontSize); const fit = useHubStore((state) => state.preferences.terminalFontFit);
  useEffect(() => {
    const screen = on ? tile.current?.querySelector<HTMLElement>('.xterm-screen') : null; if (!screen) return;
    // offsetHeight, not the rectangle's: it is in the page's pixels at any display scale, as the sheet's sizes are.
    const measure = () => { const row = terminalRow(screen.offsetHeight, terminalDimensions(sessionId).rows); if (row) tile.current?.style.setProperty('--tr-term-row', `${row}px`); };
    const observer = new ResizeObserver(measure); observer.observe(screen); measure();
    return () => observer.disconnect();
  }, [tile, sessionId, on, fontSize, fit]);
}
