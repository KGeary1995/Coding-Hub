import type { ChannelEngine } from './types';
import type { AccountLabel } from './accounts';
import type { ChatEvent } from './chat';

/** A channel as a paired phone sees it: its place, its title, and whether its CLI is running or waiting. */
/** `cols` and `rows` are the running CLI's terminal size, so the phone draws its screen at the same width. */
export interface RemoteChannel { sessionId: string; channel: number; title: string; engine: ChannelEngine; runId: string | null; running: boolean; attention: string | null; cols: number | null; rows: number | null;
  /** Set on a channel that runs on another of the person's computers and is passed on by this one (phones only). */
  computer?: { id: string; name: string };
  /** What the session is working on, from its CLI's terminal title (Claude Code's task summary). */
  topic?: string;
  /** Why its last run stopped with an error, while it is stopped (from 1.15). */
  failed?: string;
  /** A chat channel: its conversation is shown only on the computer it runs on, which is where it is answered too. */
  chat?: true;
  /** Whose Claude account the channel runs on (personal, work…), named and coloured as on its own computer. */
  account?: AccountLabel }
/** `notifications` is whether the phone turned on alerts (Web Push) for channels that need the person. */
/** `kind` is `computer` for another Trace linked to this one, which may also start and stop channels. */
export interface RemoteDevice { id: string; name: string; createdAt: string; lastSeen: string | null; notifications: boolean; kind: RemoteDeviceKind }
export type RemoteDeviceKind = 'phone' | 'computer';
/** What a linked computer may ask this one to do with a channel, beyond typing into it. */
/** `close` stops the channel if it is running and removes it, as the X on its tile does. */
export type ChannelControl = 'start' | 'stop' | 'restart' | 'close';
/** What a linked computer asks this window to do: start, stop or restart a channel, or add a new one. */
export type RemoteControlRequest = { requestId: string; sessionId: string; control: ChannelControl } | { requestId: string; add: ChannelEngine };
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
  /** The Tailscale login this computer is signed in with (`person@example.com`); computers on it may link without a code. */
  login?: string | null;
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
  pairing: { code: string; url: string; expiresAt: string; kind: RemoteDeviceKind } | null;
  /** Why the last `tailscale serve` failed, until HTTPS on the tailnet works. */
  serveProblem: ServeProblem | null;
  /** The person's other computers on the same Tailscale login link with this one without a code. */
  autoLink: boolean;
}
/**
 * What stopped Tailscale HTTPS: `certificates` (HTTPS certificates or MagicDNS are off for the tailnet), `approve`
 * (Serve waits for approval on a Tailscale page), `permission` (this user may not change Tailscale), or `other`.
 * `link` says the host holds a Tailscale page to open for it.
 */
export interface ServeProblem { kind: 'certificates' | 'approve' | 'permission' | 'other'; message: string; link: boolean }
export type RemoteRequest =
  | { action: 'remote-status' }
  | { action: 'remote-enable'; enabled: boolean }
  | { action: 'remote-pair'; kind?: RemoteDeviceKind }
  | { action: 'remote-cancel-pairing' }
  | { action: 'remote-revoke'; id: string }
  | { action: 'remote-test-alert'; id: string }
  /** `automatic` retries after the person returns from Tailscale's settings: no confirmation and no page opened. */
  | { action: 'remote-serve'; automatic?: boolean }
  | { action: 'remote-open-tailscale' }
  | { action: 'remote-auto-link'; enabled: boolean };
/** The URL fragment a pairing link carries; it never reaches a server log. */
export const PAIRING_PREFIX = '#pair=';
export const REMOTE_PORT = 47821;

/** Another of the person's computers as this one sees it: found through the Drive sync folder, and linked or not. */
export interface LinkedComputer {
  id: string; name: string; url: string | null;
  linked: boolean; connected: boolean; error: string | null;
  channels: RemoteChannel[];
}
/**
 * A Claude Code or Codex channel's conversation, from its CLI's own transcript: every run of it, since each restart
 * resumes the same conversation. Null for terminals and channels that have not run yet.
 */
export type ChannelTranscript = Extract<ChatEvent, { type: 'history' }> | null;
/** `locked` is null when that computer cannot say: Trace there is closed or older, or its system does not report it. */
export interface LinkedScreenState { locked: boolean | null }
export type LinkedComputerRequest =
  | { action: 'linked-status' }
  | { action: 'linked-link'; id: string; code: string }
  | { action: 'linked-unlink'; id: string }
  | { action: 'linked-input'; id: string; sessionId: string; runId: string; data: string }
  | { action: 'linked-control'; id: string; sessionId: string; control: ChannelControl }
  | { action: 'linked-watch'; id: string }
  | { action: 'linked-unwatch'; id: string }
  /** Adds a channel on that computer, in its own workspace. */
  | { action: 'linked-add'; id: string; engine: ChannelEngine }
  /** An image pasted here (PNG or JPEG, base64) for a channel there; that computer attaches it as if pasted there. */
  | { action: 'linked-paste-image'; id: string; sessionId: string; runId: string; image: string }
  /** Whether that computer's screen is locked, which its screen shows here as black (a Mac). */
  | { action: 'linked-screen-state'; id: string }
  /** A tile here shows that channel at its own size (`cols`/`rows`), or gives it back (without them). */
  | { action: 'linked-fit'; id: string; sessionId: string; runId: string; cols?: number; rows?: number }
  /** That channel's whole conversation (ChannelTranscript). */
  | { action: 'linked-transcript'; id: string; sessionId: string };
/** Live updates about linked computers for the desktop window. */
export type LinkedComputerEvent =
  | { type: 'computers'; computers: LinkedComputer[] }
  | { type: 'output'; id: string; sessionId: string; runId: string; data: string }
  | { type: 'replay'; id: string; sessionId: string; runId: string; data: string; cols: number; rows: number }
  | { type: 'resize'; id: string; sessionId: string; runId: string; cols: number; rows: number }
  /** An alert about that computer's channel was clicked: open its tab. */
  | { type: 'open'; id: string };
