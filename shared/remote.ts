import type { CLIEngine } from './types';

/** A channel as a paired phone sees it: its place, its title, and whether its CLI is running or waiting. */
/** `cols` and `rows` are the running CLI's terminal size, so the phone draws its screen at the same width. */
export interface RemoteChannel { sessionId: string; channel: number; title: string; engine: CLIEngine; runId: string | null; running: boolean; attention: string | null; cols: number | null; rows: number | null }
/** `notifications` is whether the phone turned on alerts (Web Push) for channels that need the person. */
export interface RemoteDevice { id: string; name: string; createdAt: string; lastSeen: string | null; notifications: boolean }
export interface TailscaleState {
  /** The tailscale CLI was found. */
  installed: boolean;
  /** Signed in and connected to the tailnet. */
  running: boolean;
  /** This computer's name on the tailnet (for example `desk.example.ts.net`), when connected. */
  host: string | null;
  /** `tailscale serve` passes HTTPS on the tailnet to the phone remote. */
  serving: boolean;
  /** Tailscale Funnel would expose the phone remote to the whole internet; the remote refuses to run behind it. */
  funnel: boolean;
  error: string | null;
}
export interface RemoteStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  url: string | null;
  error: string | null;
  devices: RemoteDevice[];
  tailscale: TailscaleState;
  /** A pairing code waiting to be used, with the link a phone opens to use it. */
  pairing: { code: string; url: string; expiresAt: string } | null;
}
export type RemoteRequest =
  | { action: 'remote-status' }
  | { action: 'remote-enable'; enabled: boolean }
  | { action: 'remote-pair' }
  | { action: 'remote-cancel-pairing' }
  | { action: 'remote-revoke'; id: string }
  | { action: 'remote-test-alert'; id: string }
  | { action: 'remote-serve' };
/** The URL fragment a pairing link carries; it never reaches a server log. */
export const PAIRING_PREFIX = '#pair=';
export const REMOTE_PORT = 47821;
