import type { Session } from '../../shared/types';
import { isChatEngineConfig } from '../../shared/types';
import type { HubPreferences, MemoryNote, UsageRecord } from '../../shared/hub';
import { LIMIT_THRESHOLD, usageFor } from '../state/channel-state';
import { leadOf, useWorkspaceStore } from '../state/workspace-store';
import { hubCall, useHubStore } from '../state/hub-store';
import { chatFailed, chatSent } from '../state/chat-store';
import { writeTerminal } from './terminals';

/**
 * Near the end of its context an agent is asked, by Trace, to save a handoff itself (the person's choice, 2026-11-22:
 * before, the tile only offered Write handoff, which opened Memory for the person to write one). Asked when the agent's
 * turn has ended, once each time a run climbs to the limit: compacting brings the context down, and the next climb asks
 * again. Only for the context window, not for a token or cost budget, which a handoff does nothing about.
 *
 * Once the handoff is in the project's memory, the channel is compacted when that turn ends, so the person does not
 * have to: the notes are safe, and the context is freed. A terminal gets `/compact`, which Claude Code and Codex both
 * have; a chat (1.43.0) the `compact` request: Claude Code takes /compact as a message there too (2.1.332), and Codex
 * has thread/compact/start.
 */

/** The share of the context window in use (0 when the CLI has not reported both numbers). */
const contextShare = (usage: UsageRecord | undefined) => usage?.context && usage.context.limit > 0 ? usage.context.used / usage.context.limit : 0;

/**
 * Whether to ask now: automatic memory is on, the channel is a running Claude Code or Codex agent that is not waiting
 * for an approval (a terminal would take the message's Enter as the answer) and is not at a Round Table (its seats take
 * turns, and a message there goes to the table), and its context is at the limit.
 */
export function handoffDue(session: Session, sessions: Session[], usage: UsageRecord | undefined, preferences: Pick<HubPreferences, 'automaticMemory'>): boolean {
  if (preferences.automaticMemory === false || session.status !== 'running' || !session.runId || session.attention) return false;
  if (!isChatEngineConfig(session.config) || session.roundTable || leadOf(sessions, session.id)) return false;
  return contextShare(usage) >= LIMIT_THRESHOLD;
}

export const handoffRequest = (percent: number) => `Trace: this conversation has used ${percent}% of its context window. Before anything else, save a handoff with the write_handoff tool (coding-hub-memory): the decisions made, the files changed, the checks run, what is left to do and any blockers. Then carry on with what you were doing.`;

/** Runs asked since their context last was under the limit. */
const asked = new Set<string>();
/** Runs asked and not yet compacted: when they were asked, and how many turns have ended since (it is given up after three). */
const waiting = new Map<string, { at: number; turns: number }>();

/** Whether that agent saved a note in the project's memory after it was asked (a few seconds' slack for clocks). */
export const handoffSaved = (notes: Pick<MemoryNote, 'author' | 'createdAt'>[], engine: 'claude' | 'codex', since: number) => notes.some((note) => note.author === engine && new Date(note.createdAt).getTime() >= since - 5000);

/** After the turn that followed the request: compacts a channel whose agent saved its handoff. Returns whether it did. */
async function compactAfterHandoff(session: Session, sessions: Session[]): Promise<boolean> {
  const runId = session.runId!; const pending = waiting.get(runId); if (!pending) return false;
  if (++pending.turns > 3) { waiting.delete(runId); return false; }
  if (!isChatEngineConfig(session.config) || session.attention || session.status !== 'running' || session.roundTable || leadOf(sessions, session.id)) return false;
  const directory = session.runningCwd ?? (session.binding.mode === 'independent' ? session.binding.cwd : useWorkspaceStore.getState().rootDirectory); if (!directory) return false;
  try {
    const project = session.config.memoryKey ?? await hubCall<string>({ action: 'memory-key', directory });
    if (!handoffSaved(await hubCall<MemoryNote[]>({ action: 'memory-list', project }), session.config.engine, pending.at)) return false;
  } catch { return false; }
  waiting.delete(runId);
  if (!session.config.chat) return writeTerminal(session.id, '/compact\r');
  if (!window.codingHub) return false;
  chatSent(session.id, '/compact', []);
  const result = await window.codingHub.chat({ action: 'compact', sessionId: session.id, runId }).catch(() => null);
  if (!result?.ok) { chatFailed(session.id, result && !result.ok ? result.error.message : 'The conversation could not be compacted.'); return false; }
  return true;
}

/** A channel's turn ended: asks its agent for a handoff if one is due. `wait`: the turn's last usage arrives a moment after it ends. */
export async function askForHandoff(sessionId: string, wait = 1500): Promise<boolean> {
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  const sessions = useWorkspaceStore.getState().sessions; const session = sessions.find((item) => item.id === sessionId); if (!session?.runId) return false;
  const usage = usageFor(session, useHubStore.getState().usage); const runId = session.runId;
  if (await compactAfterHandoff(session, sessions)) return false;
  // Back under the limit (compacted): the next climb asks again.
  if (contextShare(usage) < LIMIT_THRESHOLD) { asked.delete(runId); waiting.delete(runId); return false; }
  if (asked.has(runId) || !handoffDue(session, sessions, usage, useHubStore.getState().preferences)) return false;
  asked.add(runId); waiting.set(runId, { at: Date.now(), turns: 0 }); const text = handoffRequest(Math.round(contextShare(usage) * 100));
  if (isChatEngineConfig(session.config) && session.config.chat && window.codingHub) {
    chatSent(session.id, text, []);
    const result = await window.codingHub.chat({ action: 'send', sessionId: session.id, runId, text, images: [] }).catch(() => null);
    if (!result?.ok) { chatFailed(session.id, result && !result.ok ? result.error.message : 'The handoff request could not be sent.'); asked.delete(runId); return false; }
    return true;
  }
  const sent = await writeTerminal(session.id, text + '\r'); if (!sent) asked.delete(runId);
  return sent;
}
