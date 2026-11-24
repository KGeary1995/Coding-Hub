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
  /** A newer commit of its branch or tag, from the last update check (GitHub plugins only). */
  update?: string | null;
  /** Failed runs in a row. */
  failures: number; lastRun: PluginRun | null;
}
export interface PluginData { plugins: PluginSummary[] }
/** What installing a fetched repository would add, shown before anything runs (docs/plugins.md, section 6). */
export interface PluginPreview { fetchId: string; repo: string; ref?: string; commit: string; id: string; name: string; version: string; description: string; permissions: PluginPermission[];
  commands: { what: string; command: string[] }[]; files: string[];
  /** Installed already from GitHub: what changes. */
  update: { from: string; same: boolean; added: { what: string; command: string[] }[]; removed: { what: string; command: string[] }[]; newPermissions: PluginPermission[] } | null }
/** A repository on GitHub with the topic trace-plugin (not reviewed by anyone). */
export interface PluginBrowseItem { repo: string; description: string; stars: number; pushedAt: string; url: string }
export type PluginRequest =
  | { action: 'plugin-list' } | { action: 'plugin-link'; folder: string } | { action: 'plugin-enable'; id: string; enabled: boolean }
  | { action: 'plugin-remove'; id: string; removeData?: boolean } | { action: 'plugin-run'; id: string; actionId: string; sessionId?: string; repository?: string } | { action: 'plugin-log'; id: string }
  | { action: 'plugin-fetch'; repo: string; ref?: string } | { action: 'plugin-install'; fetchId: string } | { action: 'plugin-check' } | { action: 'plugin-browse' };
