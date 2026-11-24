/** Trace plugins, as the window sees them (electron/services/plugins, docs/plugins.md). */
export type PluginEventName = 'channel.needs-you' | 'channel.turn-ended' | 'channel.failed' | 'channel.started' | 'channel.stopped' | 'task.ready-for-review' | 'worktree.created' | 'trace.started';
export type PluginPermission = 'channels.read' | 'channels.send' | 'channels.control' | 'tasks' | 'notify';
export type PluginSource = { kind: 'folder'; path: string } | { kind: 'github'; repo: string; ref?: string; commit: string };
/** One run of a plugin's action, event command or build step, with the end of its output. */
export interface PluginRun { what: string; command: string[]; startedAt: string; endedAt: string; ok: boolean; code: number | null; note: string; output: string }
export interface PluginSummary {
  id: string; name: string; version: string; description: string; folder: string; source: PluginSource; enabled: boolean;
  /** Why it cannot run now (its manifest is gone or invalid, or needs a newer Trace), or null. */
  problem: string | null;
  permissions: PluginPermission[]; actions: { id: string; title: string; context: 'workspace' | 'channel' | 'repository' }[]; events: PluginEventName[]; tiles: { id: string; title: string }[];
  /** Failed runs in a row. */
  failures: number; lastRun: PluginRun | null;
}
export interface PluginData { plugins: PluginSummary[] }
export type PluginRequest =
  | { action: 'plugin-list' } | { action: 'plugin-link'; folder: string } | { action: 'plugin-enable'; id: string; enabled: boolean }
  | { action: 'plugin-remove'; id: string; removeData?: boolean } | { action: 'plugin-run'; id: string; actionId: string; sessionId?: string; repository?: string } | { action: 'plugin-log'; id: string };
