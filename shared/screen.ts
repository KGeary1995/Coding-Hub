/**
 * Showing and controlling a linked computer's screen through its own screen-sharing server (macOS Screen Sharing, port
 * 5900) over Tailscale. It does not need Trace running there, so it also reaches a Mac whose Trace has closed.
 */
export const SCREEN_PORT = 5900;
/** The sign-in a Mac asks for: its user name and password, saved encrypted on this computer when the person asks. */
export interface ScreenCredentials { username: string; password: string }
export type ScreenRequest =
  /**
   * Connects to that computer's screen-sharing server; bytes then flow with `screen-send` and `ScreenEvent`. The window
   * names the stream, so it is listening before the server's first bytes (sent as soon as it connects) arrive.
   */
  | { action: 'screen-open'; id: string; streamId: string }
  | { action: 'screen-send'; streamId: string; data: Uint8Array }
  | { action: 'screen-close'; streamId: string }
  | { action: 'screen-credentials'; id: string }
  | { action: 'screen-save-credentials'; id: string; username: string; password: string }
  | { action: 'screen-forget-credentials'; id: string };
export type ScreenEvent =
  | { type: 'data'; streamId: string; data: Uint8Array }
  /** `error` says why, in words the person can act on; a close the window asked for has none. */
  | { type: 'closed'; streamId: string; error?: string };
