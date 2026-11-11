import { MAX_CHANNELS } from '../../shared/schemas';
import type { ChatImage, RoundTableState } from '../../shared/chat';
import type { Session } from '../../shared/types';
import { challengerOf, createSession, fitTiles, hiddenSeats, partnerOf, plannerOf, useWorkspaceStore } from '../state/workspace-store';
import { GEMINI_MODEL } from '../../shared/gemini';
export { hierarchyDetached } from '../state/hierarchy-state';
import { chatNotice, useChatStore } from '../state/chat-store';
import { hubCall } from '../state/hub-store';
import { itemTitle } from '../../shared/memory-items';
import { HIERARCHY_MODELS } from '../../shared/chat';
import type { Finding } from '../../shared/findings';
import { settled, startSession, stopSession } from './use-native-host';
import { isAgentConfig } from '../../shared/types';

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
  if (!lead || !isAgentConfig(lead.config) || !lead.config.chat || lead.status !== 'running' || !lead.runId || !lead.runningCwd) return 'Start this chat first.';
  if (tableOf(leadId) || opening.has(leadId)) return null;
  // A table saved earlier whose partner did not come back: replaced by a new one.
  if (lead.roundTable) { const why = await retire(leadId); if (why) return why; }
  if (useWorkspaceStore.getState().sessions.length >= MAX_CHANNELS) return TABLE_FULL;
  const engine = lead.config.engine === 'claude' ? 'codex' as const : 'claude' as const;
  // The same folder the leading chat runs in, whatever the workspace root is now.
  const partner = createSession(engine, { mode: 'independent', cwd: lead.runningCwd });
  // A chat like the lead, with the same permissions and memory project (one table, one setting).
  if (isAgentConfig(partner.config)) partner.config = { ...partner.config, chat: true, ...(lead.config.permissions ? { permissions: lead.config.permissions } : {}), ...(lead.config.memoryKey ? { memoryKey: lead.config.memoryKey } : {}) };
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
  if (!findings.length || !isAgentConfig(lead.config)) return 0;
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
    const seats = hiddenSeats(useWorkspaceStore.getState().sessions, leadId); const ids = new Set(seats.map((seat) => seat.id));
    for (const seat of seats) if (live(seat)) { await settled([seat.id], 'starting'); await stopSession(seat.id); await settled([seat.id]); }
    useWorkspaceStore.setState((state) => {
      const sessions = state.sessions
        .filter((session) => !ids.has(session.id) || live(session))
        .map((session) => session.id === leadId && session.roundTable && !failure ? { ...session, roundTable: undefined } : session);
      // A seat removed, or one that would not stop (now a channel of its own, so it stays in sight): tiles to match.
      return { sessions, tiles: fitTiles(sessions, state.tiles, state.layoutMode) };
    });
    return failure;
  } finally { retiring.delete(leadId); }
}
/** Leads whose table is being closed, so a close from the window and the host's `closed` event stop the partner once. */
const retiring = new Set<string>();

type TableRequest = { action: 'table-plan'; approve: boolean; note: string } | { action: 'table-continue'; skipGemini?: boolean } | { action: 'table-waiting'; send: boolean } | { action: 'table-send'; text: string; images: ChatImage[] } | { action: 'table-driver'; driver: 'claude' | 'codex' } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' };
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
  const saved = { partner: table.partner.sessionId, driver: table.driver, rounds: table.rounds, ...(table.kind === 'hierarchy' ? { kind: 'hierarchy' as const, ...(table.planner ? { planner: table.planner.sessionId } : {}), ...(table.challenger ? { challenger: table.challenger.sessionId } : {}), ...(table.chain ? { chain: table.chain } : {}) } : {}), ...(table.findings?.length ? { findings: table.findings } : {}), ...(table.waiting !== undefined ? { waiting: table.waiting } : {}), ...(table.waitingImages?.length ? { waitingImages: table.waitingImages } : {}) };
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
    // Its Gemini seat too, once it has started; one that could not start (agy gone) is left out, as the thread says.
    const gemini = lead.roundTable.kind === 'hierarchy' && lead.roundTable.challenger ? sessions.find((session) => session.id === lead.roundTable!.challenger) ?? null : null;
    if (gemini?.status === 'starting') continue;
    const challenger = gemini?.status === 'running' && gemini.runId ? gemini : null;
    const pair = `${lead.runId}:${partner.runId}${planner ? `:${planner.runId}` : ''}${challenger ? `:${challenger.runId}` : ''}`; if (reopened.has(pair)) continue; reopened.add(pair);
    if (lead.roundTable.challenger && !challenger) chatNotice(lead.id, `The Round Table opened again without its Gemini seat${gemini?.error ? ` (${gemini.error})` : ''}. Gemini's steps are passed over until Reopen starts it.`);
    void window.codingHub?.chat({ action: 'table-open', sessionId: lead.id, runId: lead.runId, partner: { sessionId: partner.id, runId: partner.runId }, driver: lead.roundTable.driver, rounds: lead.roundTable.rounds, ...(planner?.runId ? { kind: 'hierarchy' as const, planner: { sessionId: planner.id, runId: planner.runId }, ...(challenger?.runId ? { challenger: { sessionId: challenger.id, runId: challenger.runId } } : {}), ...(lead.roundTable.chain ? { chain: lead.roundTable.chain } : {}) } : {}), ...(lead.roundTable.findings?.length ? { findings: lead.roundTable.findings } : {}), ...(lead.roundTable.waiting !== undefined ? { waiting: lead.roundTable.waiting } : {}), ...(lead.roundTable.waitingImages?.length ? { waitingImages: lead.roundTable.waitingImages } : {}) }).catch(() => {});
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
 * final reviewer (Fable 5.2 by default), a hidden Codex reviewer and, when agy is found, a hidden Gemini seat that
 * challenges the plan and reviews before Codex; all in the project folder, in one tile. Three CLIs, or four with Gemini:
 * the table counts as that many of the eight channels. The error message, or null.
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
/**
 * Why a new hierarchy table would open without Gemini, or null to try seating it: agy not found or without its ACP
 * server (Local engines), or no room for a fourth CLI. Not yet discovered counts as found: starting it tells.
 */
function geminiLeftOut(): string | null {
  const { engines, sessions } = useWorkspaceStore.getState(); const agy = engines.find((engine) => engine.engine === 'gemini');
  if (agy && !agy.available) return `Gemini CLI (agy) was not found${agy.error ? ` (${agy.error})` : ''}`;
  if (agy && agy.supportsAcp === false) return 'this Gemini CLI does not list its ACP server (agy acp); update agy';
  if (sessions.length + 2 >= MAX_CHANNELS) return `Trace runs at most ${MAX_CHANNELS} agents and terminals, and this table already takes three of them`;
  return null;
}
/** Seats a reviewer (Codex), a planner (Claude) and, when it can, Gemini at a running Claude chat's hierarchy table. The error message, or null. */
export async function openHierarchy(leadId: string): Promise<string | null> {
  const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId);
  if (!lead || lead.config.engine !== 'claude' || !lead.config.chat || lead.status !== 'running' || !lead.runId || !lead.runningCwd) return 'Start this chat first.';
  if (tableOf(leadId) || opening.has(leadId)) return null;
  const shared = { ...(lead.config.permissions ? { permissions: lead.config.permissions } : {}), ...(lead.config.memoryKey ? { memoryKey: lead.config.memoryKey } : {}) };
  const reviewer = createSession('codex', { mode: 'independent', cwd: lead.runningCwd }); const planner = createSession('claude', { mode: 'independent', cwd: lead.runningCwd });
  if (reviewer.config.engine === 'codex') reviewer.config = { ...reviewer.config, chat: true, model: HIERARCHY_MODELS.reviewer, ...shared };
  if (planner.config.engine === 'claude') planner.config = { ...planner.config, chat: true, model: HIERARCHY_MODELS.planner, ...shared, ...(lead.config.accountProfileId ? { accountProfileId: lead.config.accountProfileId } : {}) };
  // Gemini: read-only, with the table's permission level (its commands run without asking only at Full access).
  const leftOut = geminiLeftOut();
  const gemini = leftOut ? null : createSession('gemini', { mode: 'independent', cwd: lead.runningCwd });
  if (gemini) gemini.config = { engine: 'gemini', model: GEMINI_MODEL, chat: true, ...(lead.config.permissions ? { permissions: lead.config.permissions } : {}) };
  useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, reviewer, planner, ...(gemini ? [gemini] : [])].map((session) => session.id === leadId ? { ...session, roundTable: { partner: reviewer.id, planner: planner.id, ...(gemini ? { challenger: gemini.id } : {}), kind: 'hierarchy' as const, driver: 'claude' as const, rounds: 2 } } : session) }));
  opening.add(leadId);
  try {
    await Promise.all([startSession(reviewer.id), startSession(planner.id), ...(gemini ? [startSession(gemini.id)] : [])]);
    const now = useWorkspaceStore.getState().sessions; const seat = (id: string) => now.find((session) => session.id === id);
    const r = seat(reviewer.id); const p = seat(planner.id); const l = seat(leadId); let g = gemini ? seat(gemini.id) : undefined;
    for (const [s, name] of [[r, 'Codex'], [p, 'The planner']] as const) if (!s || s.status !== 'running' || !s.runId) { const why = s?.error ?? `${name} could not be started.`; await retire(leadId); return why; }
    if (!l?.runId || l.status !== 'running') { await retire(leadId); return 'This chat stopped before the Round Table opened.'; }
    // A Gemini seat that did not start is removed: the table opens with three seats, as the thread says.
    if (gemini && (!g || g.status !== 'running' || !g.runId)) { const why = g?.error ?? 'it did not start'; await dropGemini(leadId); g = undefined; chatNotice(leadId, `The Round Table opened without Gemini: ${why}.`); }
    else if (leftOut) chatNotice(leadId, `The Round Table opened without Gemini: ${leftOut}.`);
    const result = await window.codingHub?.chat({ action: 'table-open', sessionId: leadId, runId: l.runId, partner: { sessionId: r!.id, runId: r!.runId! }, planner: { sessionId: p!.id, runId: p!.runId! }, ...(g?.runId ? { challenger: { sessionId: g.id, runId: g.runId } } : {}), kind: 'hierarchy', driver: 'claude', rounds: 2 }).catch(() => null);
    if (result?.ok) return null;
    await retire(leadId); return result?.error.message ?? 'The Round Table could not be opened.';
  } finally { opening.delete(leadId); }
}

/** Stops and removes a table's Gemini seat; the table goes on with three. */
async function dropGemini(leadId: string) {
  const gemini = challengerOf(useWorkspaceStore.getState().sessions, leadId); if (!gemini) return;
  if (live(gemini)) { await settled([gemini.id], 'starting'); await stopSession(gemini.id); await settled([gemini.id]); }
  useWorkspaceStore.setState((state) => ({ sessions: state.sessions.filter((session) => session.id !== gemini.id || live(session)).map((session) => {
    if (session.id !== leadId || !session.roundTable?.challenger) return session;
    const { challenger: _dropped, ...table } = session.roundTable; return { ...session, roundTable: table };
  }) }));
}
/** Starts a hierarchy table's stopped seats; restoreTables then seats them again, and the work waits for Continue. A Gemini seat that will not start is left out. */
export async function reopenHierarchy(leadId: string): Promise<string | null> {
  const sessions = useWorkspaceStore.getState().sessions; const lead = sessions.find((session) => session.id === leadId);
  if (!lead || lead.status !== 'running') return 'Start this channel first.';
  const seats = [partnerOf(sessions, leadId), plannerOf(sessions, leadId)];
  if (seats.some((seat) => !seat)) return 'This Round Table lost its planner or reviewer. Close the table to chat with the builder alone.';
  const gemini = challengerOf(sessions, leadId);
  await Promise.all([...seats, ...(gemini ? [gemini] : [])].map((seat) => live(seat) ? undefined : startSession(seat!.id)));
  const failed = seats.map((seat) => useWorkspaceStore.getState().sessions.find((session) => session.id === seat!.id)).find((seat) => !live(seat));
  return failed ? failed.error ?? 'The planner or reviewer could not be started.' : null;
}
