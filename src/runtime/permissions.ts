import type { AgentConfig, ChannelConfig, PermissionLevel, SeatEngine } from '../../shared/types';
import { hiddenSeats, leadOf, useWorkspaceStore } from '../state/workspace-store';
import type { Session } from '../../shared/types';
import { isAgentConfig, isChatRun } from '../../shared/types';

export const PERMISSION_LEVELS: PermissionLevel[] = ['ask', 'edits', 'full'];
export const PERMISSION_LABEL: Record<PermissionLevel, string> = { ask: 'Ask', edits: 'Allow edits', full: 'Full access' };
/** What each level means for each agent, in the person's words (tooltips and the settings note). */
/** `chat`: a chat channel's (a Gemini chat differs from its terminal: see GEMINI_MODE in gemini-stream.ts). */
/** `name`: a custom agent's (its chat, phase 2: Trace answers what it asks, and asks for the mode its definition names). */
export function permissionHelp(engine: SeatEngine, level: PermissionLevel, chat = false, name = 'The agent') {
  if (engine === 'custom') return (level === 'ask' ? `${name} only reads: Trace says no to any file change it asks for, and asks you before its commands.` : level === 'edits' ? `Trace lets ${name} change files without asking you; it asks you before its commands.` : `${name} never asks: Trace allows whatever it would ask about. Use it only for work you trust.`) + ' What it does without asking at all is its own mode’s to say. A running chat changes from its next message.';
  // Ask is read-only for Gemini (plan mode, the owner's decision of 2026-11-24), in a chat and in a terminal.
  if (engine === 'gemini' && chat) return (level === 'ask' ? 'Gemini only reads: it answers and plans, but does not change your files.' : level === 'edits' ? 'Gemini edits files in the project without asking; it asks before commands.' : 'Gemini never asks: Trace allows whatever it would ask about. Use it only for work you trust.') + ' A running Gemini chat changes from its next message.';
  if (engine === 'gemini') return level === 'ask' ? 'Gemini only reads: it answers and plans, but does not change your files.' : level === 'edits' ? 'Gemini edits files in the project without asking; it asks before commands.' : 'Gemini never asks: any command, any file (its own blocked-command list still applies). Use it only for work you trust.';
  const when = engine === 'codex' ? ' A running Codex chat changes from its next message.' : '';
  // Accurate for both cases: started at Ask, the CLI's own settings apply; switched to Ask later, its plain default does.
  if (level === 'ask') return (engine === 'claude' ? 'Claude asks before edits and commands. A channel started at Ask follows Claude’s own permission settings; one switched to Ask while running uses Claude’s plain default.' : 'Codex asks when it needs to and writes only in the project. A channel started at Ask follows Codex’s own settings; one switched to Ask while running uses that default.') + when;
  if (level === 'edits') return (engine === 'claude' ? 'Claude edits files and runs safe commands (looking at the project, its tests and build) without asking; it asks before anything else.' : 'Codex edits and runs commands in the project without asking; it asks before anything outside it.') + when;
  return (engine === 'claude' ? 'Claude never asks: any command, any file. Use it only for work you trust.' : 'Codex never asks and runs without a sandbox: any command, any file. Use it only for work you trust.') + when;
}

/** The config with this level, always written out: no setting means the default (Allow edits), not Ask. */
export function withPermissions<T extends AgentConfig>(config: T, level: PermissionLevel): T { return { ...config, permissions: level }; }
/** A channel whose level a table's control sets: Claude Code, Codex, a Gemini CLI seat or a custom agent's chat. */
const tableChat = (config: ChannelConfig): config is AgentConfig => isAgentConfig(config);

/**
 * Every channel at the Round Table a channel leads or sits at: the lead and all its hidden seats. One table, one permission level; a channel at no table is alone.
 */
export function tableSeats(sessions: Session[], id: string): Session[] {
  const lead = leadOf(sessions, id) ?? sessions.find((session) => session.id === id); if (!lead) return [];
  return [lead, ...hiddenSeats(sessions, lead.id).filter((seat) => seat.id !== lead.id)];
}

/**
 * An agent refused a change after accepting the request (Claude answers later): its level is back to `level`. At a
 * Round Table every other seat is set back too, so one control never stands for two different levels.
 */
export async function permissionsRefused(sessionId: string, runId: string, level: PermissionLevel) {
  const sessions = useWorkspaceStore.getState().sessions; const self = sessions.find((session) => session.id === sessionId);
  if (!self || self.runId !== runId) return;
  const others = tableSeats(sessions, sessionId).filter((seat) => seat.id !== sessionId);
  const ids = new Set([sessionId, ...others.map((seat) => seat.id)]);
  useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => ids.has(session.id) && tableChat(session.config) ? { ...session, config: withPermissions(session.config, level) } : session) }));
  for (const other of others) if (isChatRun(other.config) && other.status === 'running' && other.runId) await window.codingHub?.chat({ action: 'permissions', sessionId: other.id, runId: other.runId, level }).catch(() => null);
}

/**
 * Sets what a channel's agent may do without asking, and every other seat's at its Round Table too (one table, one
 * setting). A running chat changes at once (Codex from its next message); a terminal channel takes it at its next start. If a
 * running chat refuses, the channels go back to what they had, so the control never shows a level not in effect.
 * The error message, or null.
 */
export async function setPermissions(sessionId: string, level: PermissionLevel): Promise<string | null> {
  const state = useWorkspaceStore.getState();
  const ids = new Set([sessionId, ...tableSeats(state.sessions, sessionId).map((seat) => seat.id)]);
  const before = new Map(state.sessions.filter((session) => ids.has(session.id)).map((session) => [session.id, session.config]));
  const apply = (configs: (id: string) => ChannelConfig | undefined) => useWorkspaceStore.setState((current) => ({ sessions: current.sessions.map((session) => { const config = ids.has(session.id) ? configs(session.id) : undefined; return config && session.config.engine === config.engine ? { ...session, config } : session; }) }));
  // Allowed while running, unlike other engine settings: it is the one setting a running chat can change.
  apply((id) => { const config = before.get(id); return config && tableChat(config) ? withPermissions(config, level) : undefined; });
  const changed: { id: string; runId: string; old: PermissionLevel }[] = [];
  for (const session of useWorkspaceStore.getState().sessions) {
    // Every run driven through its protocol, a Gemini CLI seat among them (it was passed over up to 1.29.0, and kept its old level).
    if (!ids.has(session.id) || !isChatRun(session.config) || session.status !== 'running' || !session.runId || !window.codingHub) continue;
    const result = await window.codingHub.chat({ action: 'permissions', sessionId: session.id, runId: session.runId, level }).catch(() => null);
    const old = before.get(session.id); const oldLevel = old && tableChat(old) ? old.permissions ?? 'edits' : 'edits';
    if (!result?.ok) {
      // Undo: the configs as they were, and any chat already switched back to its old level.
      apply((id) => before.get(id));
      for (const done of changed) await window.codingHub.chat({ action: 'permissions', sessionId: done.id, runId: done.runId, level: done.old }).catch(() => null);
      return result?.error.message ?? 'Trace could not change the permissions.';
    }
    changed.push({ id: session.id, runId: session.runId, old: oldLevel });
  }
  return null;
}
