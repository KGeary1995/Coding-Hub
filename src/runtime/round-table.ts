import { MAX_CHANNELS } from '../../shared/schemas';
import type { ChatImage, RoundTableState } from '../../shared/chat';
import type { Session } from '../../shared/types';
import { createSession, fitTiles, partnerOf, plannerOf, useWorkspaceStore } from '../state/workspace-store';
export { hierarchyDetached } from '../state/hierarchy-state';
import { useChatStore } from '../state/chat-store';
import { hubCall } from '../state/hub-store';
import { itemTitle } from '../../shared/memory-items';
import { HIERARCHY_MODELS } from '../../shared/chat';
import type { Finding } from '../../shared/findings';
import { settled, startSession, stopSession } from './use-native-host';

const NAME = { claude: 'Claude Code', codex: 'Codex' } as const;
/** Rounds a new table discusses after each message: both answer, then each replies to the other twice at most. */
export const DEFAULT_ROUNDS = 2;
/** The person sees one channel for a Round Table, but its partner is a second CLI process, so it counts toward the eight. */
export const TABLE_FULL = `Close a channel first: a Round Table runs two agents in one channel, and Trace runs at most ${MAX_CHANNELS} agents and terminals at once.`;

/** The Round Table a chat channel leads, if any. */
export const tableOf = (sessionId: string): RoundTableState | null => useChatStore.getState().threads[sessionId]?.table ?? null;

/** Leads whose partner is being added and started here, so restoreTables does not seat it a second time meanwhile. */
const opening = new Set<string>();
const live = (session: Session | null | undefined) => session?.status === 'running' || session?.status === 'starting';

/**
 * Seats the other agent at a running chat channel's Round Table: a chat of the other engine in the same folder, with no
 * tile of its own (the lead saves it as its `roundTable.partner` at once, which hides it), started, then joined to this
 * one. The channel it was opened from leads; its agent drives first. If it cannot be seated, it is stopped and removed.
 */
export async function openRoundTable(leadId: string): Promise<string | null> {
  const workspace = useWorkspaceStore.getState(); const lead = workspace.sessions.find((session) => session.id === leadId);
  if (!lead || lead.config.engine === 'shell' || !lead.config.chat || lead.status !== 'running' || !lead.runId || !lead.runningCwd) return 'Start this chat first.';
  if (tableOf(leadId) || opening.has(leadId)) return null;
  // A table saved earlier whose partner did not come back: replaced by a new one.
  if (lead.roundTable) { const why = await retire(leadId); if (why) return why; }
  if (useWorkspaceStore.getState().sessions.length >= MAX_CHANNELS) return TABLE_FULL;
  const engine = lead.config.engine === 'claude' ? 'codex' as const : 'claude' as const;
  // The same folder the leading chat runs in, whatever the workspace root is now.
  const partner = createSession(engine, { mode: 'independent', cwd: lead.runningCwd });
  // A chat like the lead, with the same permissions and memory project (one table, one setting).
  if (partner.config.engine !== 'shell') partner.config = { ...partner.config, chat: true, ...(lead.config.permissions ? { permissions: lead.config.permissions } : {}), ...(lead.config.memoryKey ? { memoryKey: lead.config.memoryKey } : {}) };
  useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, partner].map((session) => session.id === leadId ? { ...session, roundTable: { partner: partner.id, driver: lead.config.engine as 'claude' | 'codex', rounds: DEFAULT_ROUNDS } } : session) }));
  opening.add(leadId);
  try {
    await startSession(partner.id);
    const started = useWorkspaceStore.getState().sessions.find((session) => session.id === partner.id);
    const now = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId);
    if (!started || started.status !== 'running' || !started.runId) { const why = started?.error ?? `${NAME[engine]} could not be started.`; await retire(leadId); return why; }
    if (!now?.runId || now.status !== 'running') { await retire(leadId); return 'This chat stopped before the Round Table opened.'; }
    const result = await window.codingHub?.chat({ action: 'table-open', sessionId: leadId, runId: now.runId, partner: { sessionId: started.id, runId: started.runId }, driver: lead.config.engine, rounds: DEFAULT_ROUNDS }).catch(() => null);
    if (result?.ok) return null;
    await retire(leadId); return result?.error.message ?? 'The Round Table could not be opened.';
  } finally { opening.delete(leadId); }
}

/**
 * The lead forgets its table, and its hidden partner is stopped and removed. A partner that would not stop is kept,
 * and as the table is forgotten it gets a tile of its own, so a running agent is never left out of sight.
 */
/** One line of the review record for a finding: what, where, and what became of it. */
const findingLine = (finding: Finding) => [`${finding.id} (${finding.severity}), ${finding.status}${finding.evidence ? `, at ${finding.evidence}` : ''}: ${finding.text}`, finding.response && `Driver: ${finding.response}`, finding.check && `Reviewer: ${finding.check}`, finding.reviewedAt && `Reviewed on files ${finding.reviewedAt}${finding.filesChanged ? ' (files changed while it was reviewed)' : ''}${finding.changedAt ? `, answered on ${finding.changedAt}` : ''}.`].filter(Boolean).join(' · ');

/**
 * A table's findings outlive it, in the project's shared memory (the channel's chosen memory project, or its folder's):
 * the whole review record as one note, verified findings included, and each finding not yet verified as an open item, so
 * later sessions see it until someone resolves it. Throws when memory cannot be written; nothing is dropped then.
 */
export async function keepFindings(lead: Session): Promise<number> {
  const findings = lead.roundTable?.findings ?? []; const open = findings.filter((finding) => finding.status !== 'verified');
  const directory = lead.runningCwd ?? (lead.binding.mode === 'independent' ? lead.binding.cwd : useWorkspaceStore.getState().rootDirectory);
  if (!findings.length || lead.config.engine === 'shell') return 0;
  if (!lead.config.memoryKey && !directory) throw new Error('This channel has no folder to find its memory project from.');
  const project = lead.config.memoryKey ?? await hubCall<string>({ action: 'memory-key', directory: directory! });
  await hubCall({ action: 'memory-write', project, title: `Round Table review record: ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}, ${findings.length - open.length} verified`, content: ['Saved by Trace when the Round Table closed.', ...findings.map((finding) => `- ${findingLine(finding)}`)].join('\n'), author: 'human' });
  for (const finding of open) {
    const content = [`Round Table finding ${finding.id} (${finding.severity}), ${finding.status}${finding.evidence ? `, at ${finding.evidence}` : ''}: ${finding.text}`, finding.response && `Driver: ${finding.response}`, finding.check && `Reviewer: ${finding.check}`, finding.reviewedAt && `Reviewed on files ${finding.reviewedAt}${finding.filesChanged ? ' (files changed while it was reviewed)' : ''}.`, 'Saved by Trace when the Round Table closed, because it was not verified.'].filter(Boolean).join('\n');
    await hubCall({ action: 'memory-write', project, title: itemTitle(`Round Table ${finding.id} (${finding.severity}, ${finding.status}): ${finding.text}`), content, author: 'human' });
  }
  return findings.length;
}

/**
 * Saves a table's findings to shared memory and takes them off its saved record, so they are saved once. The error
 * message when memory cannot be written (the findings stay on the record then), or null.
 */
export async function archiveFindings(leadId: string): Promise<string | null> {
  const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId); if (!lead?.roundTable?.findings?.length) return null;
  try { await keepFindings(lead); } catch (error) { return `The Round Table's findings could not be saved to shared memory (${(error as Error).message}). They are kept with the channel; Needs you can try again.`; }
  useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === leadId && session.roundTable ? { ...session, roundTable: { ...session.roundTable, findings: undefined } } : session) }));
  return null;
}

/** Returns an error message when the findings could not be saved: the table's record then stays with the lead, findings and all. */
async function retire(leadId: string): Promise<string | null> {
  if (retiring.has(leadId)) return null; retiring.add(leadId);
  try {
    const failure = await archiveFindings(leadId);
    const partner = partnerOf(useWorkspaceStore.getState().sessions, leadId); const planner = plannerOf(useWorkspaceStore.getState().sessions, leadId);
    for (const seat of [partner, planner]) if (seat && live(seat)) { await settled([seat.id], 'starting'); await stopSession(seat.id); await settled([seat.id]); }
    useWorkspaceStore.setState((state) => {
      const sessions = state.sessions
        .filter((session) => (session.id !== partner?.id && session.id !== planner?.id) || live(session))
        .map((session) => session.id === leadId && session.roundTable && !failure ? { ...session, roundTable: undefined } : session);
      // A seat removed, or one that would not stop (now a channel of its own, so it stays in sight): tiles to match.
      return { sessions, tiles: fitTiles(sessions, state.tiles, state.layoutMode) };
    });
    return failure;
  } finally { retiring.delete(leadId); }
}
/** Leads whose table is being closed, so a close from the window and the host's `closed` event stop the partner once. */
const retiring = new Set<string>();

type TableRequest = { action: 'table-plan'; approve: boolean; note: string } | { action: 'table-continue' } | { action: 'table-waiting'; send: boolean } | { action: 'table-send'; text: string; images: ChatImage[] } | { action: 'table-driver'; driver: 'claude' | 'codex' } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' };
/** A request to the table a running chat channel leads; the error message, or null. */
export async function tableRequest(leadId: string, request: TableRequest): Promise<string | null> {
  const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId);
  if (!lead?.runId || !window.codingHub) return 'This chat is not running.';
  const result = await window.codingHub.chat({ ...request, sessionId: lead.id, runId: lead.runId }).catch(() => null);
  return result?.ok ? null : result?.error.message ?? 'Trace could not reach the Round Table.';
}

/** The leading channel remembers its table (partner, driver, rounds) whenever the table changes. */
export function rememberTable(leadId: string, table: RoundTableState) {
  // The review record and a waiting message are kept with it, so a restart loses neither.
  const saved = { partner: table.partner.sessionId, driver: table.driver, rounds: table.rounds, ...(table.kind === 'hierarchy' ? { kind: 'hierarchy' as const, ...(table.planner ? { planner: table.planner.sessionId } : {}), ...(table.chain ? { chain: table.chain } : {}) } : {}), ...(table.findings?.length ? { findings: table.findings } : {}), ...(table.waiting !== undefined ? { waiting: table.waiting } : {}), ...(table.waitingImages?.length ? { waitingImages: table.waitingImages } : {}) };
  useWorkspaceStore.setState((state) => {
    const lead = state.sessions.find((session) => session.id === leadId);
    if (!lead || (lead.roundTable && JSON.stringify(lead.roundTable) === JSON.stringify(saved))) return {};
    const sessions = state.sessions.map((session) => session.id === leadId ? { ...session, roundTable: saved } : session);
    // A seat added as a channel (a table opened from a phone) is hidden now: its tile goes.
    return { sessions, tiles: fitTiles(sessions, state.tiles, state.layoutMode) };
  });
}
/** Closing the table (the person's choice, not Trace quitting) forgets it, so it is not opened again, and stops its partner. */
export function forgetTable(leadId: string) { return retire(leadId); }
/** Pairs of runs already seated again, so a table that fails to open is not tried over and over. */
const reopened = new Set<string>();
/**
 * After a restart (or after both chats were stopped and started again), a leading chat and its saved partner that both
 * run again are seated at the table again, with the same driver and rounds. Both conversations resumed, so the partner
 * is not briefed again.
 */
export function restoreTables() {
  const { sessions } = useWorkspaceStore.getState();
  for (const lead of sessions) {
    if (!lead.roundTable || lead.status !== 'running' || !lead.runId || tableOf(lead.id) || opening.has(lead.id)) continue;
    const partner = sessions.find((session) => session.id === lead.roundTable!.partner);
    if (!partner || partner.status !== 'running' || !partner.runId) continue;
    // A hierarchy table opens again once its planner runs too, picking up where its work stood.
    const planner = lead.roundTable.kind === 'hierarchy' ? sessions.find((session) => session.id === lead.roundTable!.planner) : null;
    if (lead.roundTable.kind === 'hierarchy' && (!planner || planner.status !== 'running' || !planner.runId)) continue;
    const pair = `${lead.runId}:${partner.runId}${planner ? `:${planner.runId}` : ''}`; if (reopened.has(pair)) continue; reopened.add(pair);
    void window.codingHub?.chat({ action: 'table-open', sessionId: lead.id, runId: lead.runId, partner: { sessionId: partner.id, runId: partner.runId }, driver: lead.roundTable.driver, rounds: lead.roundTable.rounds, ...(planner?.runId ? { kind: 'hierarchy' as const, planner: { sessionId: planner.id, runId: planner.runId }, ...(lead.roundTable.chain ? { chain: lead.roundTable.chain } : {}) } : {}), ...(lead.roundTable.findings?.length ? { findings: lead.roundTable.findings } : {}), ...(lead.roundTable.waiting !== undefined ? { waiting: lead.roundTable.waiting } : {}), ...(lead.roundTable.waitingImages?.length ? { waitingImages: lead.roundTable.waitingImages } : {}) }).catch(() => {});
  }
}

/**
 * + Channel → Round Table: a Claude chat in the project, started, with Codex seated at it in the background
 * (openRoundTable), all in one tile. Claude drives first; the person can swap. The error message, or null.
 */
export async function startRoundTable(): Promise<string | null> {
  const before = new Set(useWorkspaceStore.getState().sessions.map((session) => session.id));
  if (before.size > MAX_CHANNELS - 2) return TABLE_FULL;
  useWorkspaceStore.getState().addChatSession('claude');
  const lead = useWorkspaceStore.getState().sessions.find((session) => !before.has(session.id));
  if (!lead) return 'The Round Table could not be added.';
  await startSession(lead.id);
  const started = useWorkspaceStore.getState().sessions.find((session) => session.id === lead.id);
  if (started?.status !== 'running') return started?.error ?? 'Claude could not be started.';
  return openRoundTable(lead.id);
}

/**
 * + Channel → Round Table (hierarchy): a Claude chat that builds (Opus 5.5 by default), with a hidden Claude planner and
 * final reviewer (Fable 5.2 by default) and a hidden Codex reviewer, all in the project folder, in one tile. Three CLIs:
 * the table counts as three of the eight channels. The error message, or null.
 */
export async function startHierarchyTable(): Promise<string | null> {
  const before = new Set(useWorkspaceStore.getState().sessions.map((session) => session.id));
  if (before.size > MAX_CHANNELS - 3) return 'A hierarchy Round Table runs three agents, and Trace runs at most eight. Close a channel first.';
  useWorkspaceStore.getState().addChatSession('claude');
  const lead = useWorkspaceStore.getState().sessions.find((session) => !before.has(session.id));
  if (!lead || lead.config.engine !== 'claude') return 'The Round Table could not be added.';
  useWorkspaceStore.getState().updateConfig(lead.id, { ...lead.config, model: HIERARCHY_MODELS.builder });
  await startSession(lead.id);
  const started = useWorkspaceStore.getState().sessions.find((session) => session.id === lead.id);
  if (started?.status !== 'running') return started?.error ?? 'Claude could not be started.';
  return openHierarchy(lead.id);
}
/** Seats a reviewer (Codex) and a planner (Claude) at a running Claude chat's hierarchy table. The error message, or null. */
export async function openHierarchy(leadId: string): Promise<string | null> {
  const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId);
  if (!lead || lead.config.engine !== 'claude' || !lead.config.chat || lead.status !== 'running' || !lead.runId || !lead.runningCwd) return 'Start this chat first.';
  if (tableOf(leadId) || opening.has(leadId)) return null;
  const shared = { ...(lead.config.permissions ? { permissions: lead.config.permissions } : {}), ...(lead.config.memoryKey ? { memoryKey: lead.config.memoryKey } : {}) };
  const reviewer = createSession('codex', { mode: 'independent', cwd: lead.runningCwd }); const planner = createSession('claude', { mode: 'independent', cwd: lead.runningCwd });
  if (reviewer.config.engine === 'codex') reviewer.config = { ...reviewer.config, chat: true, ...shared };
  if (planner.config.engine === 'claude') planner.config = { ...planner.config, chat: true, model: HIERARCHY_MODELS.planner, ...shared, ...(lead.config.accountProfileId ? { accountProfileId: lead.config.accountProfileId } : {}) };
  useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, reviewer, planner].map((session) => session.id === leadId ? { ...session, roundTable: { partner: reviewer.id, planner: planner.id, kind: 'hierarchy' as const, driver: 'claude' as const, rounds: 2 } } : session) }));
  opening.add(leadId);
  try {
    await Promise.all([startSession(reviewer.id), startSession(planner.id)]);
    const now = useWorkspaceStore.getState().sessions; const seat = (id: string) => now.find((session) => session.id === id);
    const r = seat(reviewer.id); const p = seat(planner.id); const l = seat(leadId);
    for (const [s, name] of [[r, 'Codex'], [p, 'The planner']] as const) if (!s || s.status !== 'running' || !s.runId) { const why = s?.error ?? `${name} could not be started.`; await retire(leadId); return why; }
    if (!l?.runId || l.status !== 'running') { await retire(leadId); return 'This chat stopped before the Round Table opened.'; }
    const result = await window.codingHub?.chat({ action: 'table-open', sessionId: leadId, runId: l.runId, partner: { sessionId: r!.id, runId: r!.runId! }, planner: { sessionId: p!.id, runId: p!.runId! }, kind: 'hierarchy', driver: 'claude', rounds: 2 }).catch(() => null);
    if (result?.ok) return null;
    await retire(leadId); return result?.error.message ?? 'The Round Table could not be opened.';
  } finally { opening.delete(leadId); }
}

/** Starts a hierarchy table's stopped seats; restoreTables then seats them again, and the work waits for Continue. */
export async function reopenHierarchy(leadId: string): Promise<string | null> {
  const sessions = useWorkspaceStore.getState().sessions; const lead = sessions.find((session) => session.id === leadId);
  if (!lead || lead.status !== 'running') return 'Start this channel first.';
  const seats = [partnerOf(sessions, leadId), plannerOf(sessions, leadId)];
  if (seats.some((seat) => !seat)) return 'This Round Table lost its planner or reviewer. Close the table to chat with the builder alone.';
  await Promise.all(seats.map((seat) => live(seat) ? undefined : startSession(seat!.id)));
  const failed = seats.map((seat) => useWorkspaceStore.getState().sessions.find((session) => session.id === seat!.id)).find((seat) => !live(seat));
  return failed ? failed.error ?? 'The planner or reviewer could not be started.' : null;
}
