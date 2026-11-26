import type { Session } from '../../shared/types';
import { isChatEngineConfig } from '../../shared/types';
import type { RoundTableState } from '../../shared/chat';
import { handoffRequest, type HubPreferences, type MemoryNote, type UsageRecord } from '../../shared/hub';
import { LIMIT_THRESHOLD, usageFor } from '../state/channel-state';
import { hiddenSeats, leadOf, useWorkspaceStore } from '../state/workspace-store';
import { hubCall, useHubStore } from '../state/hub-store';
import { chatFailed, chatSent, useChatStore } from '../state/chat-store';
import { submitTerminal } from './terminals';
import { contextShare, handoffHandled, setHandoffPhase, tableLeadOf } from '../state/handoff-store';
import { channelDirectory } from '../state/channel-names';

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


/**
 * Whether to ask now: automatic memory is on, the channel is a running agent Trace handles (handoffHandled) that is not
 * waiting for an approval (a terminal would take the message's Enter as the answer), and its context is at the limit.
 * At a Round Table (from 1.47; its seats take turns, and a message there goes to every seat) only while `table` rests:
 * no discussion under way and no message of the person's waiting. The host checks that again, with which seats are busy.
 */
export function handoffDue(session: Session, sessions: Session[], usage: UsageRecord | undefined, preferences: Pick<HubPreferences, 'automaticMemory'>, table?: RoundTableState | null): boolean {
  if (preferences.automaticMemory === false || session.status !== 'running' || !session.runId || session.attention) return false;
  if (!handoffHandled(session, sessions) || (tableLeadOf(sessions, session) && !resting(table))) return false;
  return contextShare(usage) >= LIMIT_THRESHOLD;
}
const resting = (table: RoundTableState | null | undefined) => Boolean(table && table.kind !== 'hierarchy' && table.phase === 'idle' && table.waiting === undefined && !table.waitingImages?.length);

export { handoffRequest };

/** Runs asked since their context last was under the limit. */
const asked = new Set<string>();
/** Runs asked and not yet compacted: when they were asked, and how many turns have ended since (it is given up after three). */
const waiting = new Map<string, { at: number; turns: number }>();

/** Seats whose handoff is saved, still to be compacted once their table rests. */
const compacting = new Set<string>();

/** Whether that agent saved a note in the project's memory after it was asked (a few seconds' slack for clocks). */
export const handoffSaved = (notes: Pick<MemoryNote, 'author' | 'createdAt'>[], engine: 'claude' | 'codex' | 'gemini', since: number) => notes.some((note) => note.author === engine && new Date(note.createdAt).getTime() >= since - 5000);
/** Whether the run's agent has saved its handoff in its project's memory since `since` (false when that cannot be read). Gemini's key is always its folder's. */
async function written(session: Session, since: number): Promise<boolean> {
  const directory = channelDirectory(session, useWorkspaceStore.getState().rootDirectory); const engine = session.config.engine;
  if (!directory || (engine !== 'claude' && engine !== 'codex' && engine !== 'gemini')) return false;
  try {
    const project = (isChatEngineConfig(session.config) ? session.config.memoryKey : undefined) ?? await hubCall<string>({ action: 'memory-key', directory });
    return handoffSaved(await hubCall<MemoryNote[]>({ action: 'memory-list', project }), engine, since);
  } catch { return false; }
}

/** After the turn that followed the request: compacts a channel whose agent saved its handoff. Returns whether it did. */
async function compactAfterHandoff(session: Session, sessions: Session[]): Promise<boolean> {
  const runId = session.runId!; const pending = waiting.get(runId); if (!pending) return false;
  if (++pending.turns > 3) { waiting.delete(runId); setHandoffPhase(session.id, runId, 'not-saved'); return false; }
  if (!isChatEngineConfig(session.config) || session.attention || session.status !== 'running' || session.roundTable || leadOf(sessions, session.id)) return false;
  if (!await written(session, pending.at)) return false;
  waiting.delete(runId); setHandoffPhase(session.id, runId, 'saved');
  if (!session.config.chat) { const sent = await submitTerminal(session.id, '/compact'); if (sent) setHandoffPhase(session.id, runId, 'compacted'); return sent; }
  if (!window.codingHub) return false;
  chatSent(session.id, '/compact', []);
  const result = await window.codingHub.chat({ action: 'compact', sessionId: session.id, runId }).catch(() => null);
  if (!result?.ok) { chatFailed(session.id, result && !result.ok ? result.error.message : 'The conversation could not be compacted.'); return false; }
  setHandoffPhase(session.id, runId, 'compacted'); return true;
}

/** A channel's turn ended: asks its agent for a handoff if one is due. `wait`: the turn's last usage arrives a moment after it ends. */
export async function askForHandoff(sessionId: string, wait = 1500): Promise<boolean> {
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  const sessions = useWorkspaceStore.getState().sessions; const session = sessions.find((item) => item.id === sessionId); if (!session?.runId) return false;
  const lead = tableLeadOf(sessions, session); if (lead) return tableHandoff(session, lead);
  const usage = usageFor(session, useHubStore.getState().usage); const runId = session.runId;
  if (await compactAfterHandoff(session, sessions)) return false;
  // Back under the limit (compacted): the next climb asks again.
  if (contextShare(usage) < LIMIT_THRESHOLD) { asked.delete(runId); if (waiting.delete(runId)) setHandoffPhase(session.id, runId, null); return false; }
  if (asked.has(runId) || !handoffDue(session, sessions, usage, useHubStore.getState().preferences)) return false;
  asked.add(runId); waiting.set(runId, { at: Date.now(), turns: 0 }); const text = handoffRequest(Math.round(contextShare(usage) * 100));
  if (isChatEngineConfig(session.config) && session.config.chat && window.codingHub) {
    chatSent(session.id, text, []);
    const result = await window.codingHub.chat({ action: 'send', sessionId: session.id, runId, text, images: [] }).catch(() => null);
    if (!result?.ok) { chatFailed(session.id, result && !result.ok ? result.error.message : 'The handoff request could not be sent.'); asked.delete(runId); return false; }
    setHandoffPhase(session.id, runId, 'asked'); return true;
  }
  const sent = await submitTerminal(session.id, text); if (!sent) asked.delete(runId); else setHandoffPhase(session.id, runId, 'asked');
  return sent;
}

/**
 * A Round Table's seat ended a turn (from 1.47): its saved handoff is looked for, as a channel's is; then, if the table
 * rests, one seat is compacted (its handoff saved) or asked for its handoff (at the limit, not asked this climb), each
 * as a turn of its own through the table (RoundTables.aside), so nothing is relayed and no round starts. One at a time:
 * the turn's end comes back here and does the next. Returns whether a seat was asked.
 */
async function tableHandoff(ended: Session, lead: Session): Promise<boolean> {
  const runId = ended.runId!; const pending = waiting.get(runId);
  if (pending) {
    if (++pending.turns > 3) { waiting.delete(runId); setHandoffPhase(ended.id, runId, 'not-saved'); }
    else if (await written(ended, pending.at)) { waiting.delete(runId); setHandoffPhase(ended.id, runId, 'saved'); compacting.add(runId); }
  }
  if (!window.codingHub || !lead.runId) return false;
  const table = useChatStore.getState().threads[lead.id]?.table; if (!resting(table)) return false;
  const sessions = useWorkspaceStore.getState().sessions; const records = useHubStore.getState().usage; const preferences = useHubStore.getState().preferences;
  const seats = [lead, ...hiddenSeats(sessions, lead.id)].flatMap((seat) => sessions.find((item) => item.id === seat.id && item.runId) ?? []);
  const reference = (seat: Session) => ({ action: 'table-compact' as const, sessionId: lead.id, runId: lead.runId!, seat: { sessionId: seat.id, runId: seat.runId! } });
  for (const seat of seats) if (compacting.has(seat.runId!) && seat.status === 'running' && !seat.attention) {
    const result = await window.codingHub.chat(reference(seat)).catch(() => null);
    // Busy again (the person's message went first): compacted when the table next rests. Any other refusal is final (a
    // Gemini seat whose agy has not listed its compact command stays saved).
    if (result?.ok || result?.error.code !== 'TABLE_BUSY') compacting.delete(seat.runId!);
    if (result?.ok) setHandoffPhase(seat.id, seat.runId!, 'compacted');
    return false;
  }
  for (const seat of seats) {
    const usage = usageFor(seat, records); const seatRun = seat.runId!;
    // Back under the limit (compacted): the next climb asks again.
    if (contextShare(usage) < LIMIT_THRESHOLD) { asked.delete(seatRun); compacting.delete(seatRun); if (waiting.delete(seatRun)) setHandoffPhase(seat.id, seatRun, null); continue; }
    if (asked.has(seatRun) || !handoffDue(seat, sessions, usage, preferences, table)) continue;
    asked.add(seatRun); waiting.set(seatRun, { at: Date.now(), turns: 0 });
    const result = await window.codingHub.chat({ ...reference(seat), action: 'table-handoff', percent: Math.min(100, Math.round(contextShare(usage) * 100)) }).catch(() => null);
    if (!result?.ok) { asked.delete(seatRun); waiting.delete(seatRun); return false; }
    setHandoffPhase(seat.id, seatRun, 'asked'); return true;
  }
  return false;
}
