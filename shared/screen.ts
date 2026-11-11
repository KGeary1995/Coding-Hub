/**
 * Showing and controlling a linked computer's screen. A Mac is reached through its own screen-sharing server (macOS
 * Screen Sharing, port 5900). Windows has none, so Trace installs its own there: a background service (Trace started
 * with --screen-service at sign-in) that serves the screen to linked computers, also while Trace is closed. Both are
 * reached over Tailscale; the service at https://<name>.ts.net/api/screen, which `tailscale serve` passes to it.
 */
export const SCREEN_PORT = 5900;
/** Where the Windows screen service listens, on this computer only. */
export const SCREEN_SERVICE_PORT = 47822;
export const SCREEN_SERVICE_PATH = '/api/screen';
/** `trace`: Trace's own screen server on that computer (Windows). `system`: that computer's own (macOS Screen Sharing). */
export type ScreenKind = 'trace' | 'system';
/** The sign-in a Mac asks for: its user name and password, saved encrypted on this computer when the person asks. */
export interface ScreenCredentials { username: string; password: string }
/** Whether this computer serves its screen to linked computers (Windows), and whether the service is running now. */
/** `elevated`: the service runs as administrator, so it can also control apps that do. */
export interface ScreenShareStatus { supported: boolean; enabled: boolean; elevated: boolean; running: boolean }
export type ScreenRequest =
  /**
   * Connects to that computer's screen; bytes then flow with `screen-send` and `ScreenEvent`. The window names the
   * stream, so it is listening before the server's first bytes (sent as soon as it connects) arrive.
   */
  | { action: 'screen-open'; id: string; streamId: string; /** A Trace screen service (Windows): 0 or none for every display, 1 and up for one of them (left to right). */ display?: number }
  | { action: 'screen-send'; streamId: string; data: Uint8Array }
  | { action: 'screen-close'; streamId: string }
  | { action: 'screen-credentials'; id: string }
  | { action: 'screen-save-credentials'; id: string; username: string; password: string }
  | { action: 'screen-forget-credentials'; id: string }
  /** This computer's own screen, served to linked computers (Windows only). */
  | { action: 'screen-share-status' }
  | { action: 'screen-share-set'; enabled: boolean; /** Left out: as it was. */ elevated?: boolean };
/** `displays` and `display`: from a Trace screen service, how many displays it has and which one it shows (0 for all). */
export interface ScreenOpened { kind: ScreenKind; displays?: number; display?: number }
/** The most displays one can be picked from. */
export const MAX_DISPLAYS = 16;
/** The most clipboard text Trace's screen service takes in one message, in bytes as it travels (CRLF, UTF-8, a closing NUL). */
export const SCREEN_CLIPBOARD_LIMIT = 1024 * 1024;
/**
 * A paste cut to what the screen service takes (between characters), so a long one is pasted shortened rather than
 * ending the session. Counted as noVNC sends it: line ends as CRLF, then UTF-8, then a NUL.
 */
export function fitPaste(text: string, limit = SCREEN_CLIPBOARD_LIMIT): string {
  const encoder = new TextEncoder(); const size = (value: string) => encoder.encode(value.replace(/\r\n|\r|\n/g, '\r\n')).length + 1;
  if (size(text) <= limit) return text;
  const characters = Array.from(text); let fits = 0; let over = characters.length;
  while (over - fits > 1) { const middle = (fits + over) >> 1; if (size(characters.slice(0, middle).join('')) <= limit) fits = middle; else over = middle; }
  return characters.slice(0, fits).join('');
}
export type ScreenResponse = ScreenOpened | ScreenCredentials | ScreenShareStatus | null;
export type ScreenEvent =
  | { type: 'data'; streamId: string; data: Uint8Array }
  /** `error` says why, in words the person can act on; a close the window asked for has none. */
  | { type: 'closed'; streamId: string; error?: string };
