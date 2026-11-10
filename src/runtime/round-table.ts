import { MAX_CHANNELS } from '../../shared/schemas';
import type { ChatImage, RoundTableState } from '../../shared/chat';
import type { Session } from '../../shared/types';
import { createSession, partnerOf, useWorkspaceStore } from '../state/workspace-store';
import { useChatStore } from '../state/chat-store';
import { hubCall } from '../state/hub-store';
import { itemTitle } from '../../shared/memory-items';
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
  if (lead.roundTable) await retire(leadId);
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
/**
 * Findings not yet verified outlive the table: each becomes an open item in the project's shared memory (the channel's
 * chosen memory project, or its folder's), so later sessions see it until someone resolves it.
 */
export async function keepFindings(lead: Session): Promise<number> {
  const open = (lead.roundTable?.findings ?? []).filter((finding) => finding.status !== 'verified');
  const directory = lead.runningCwd ?? (lead.binding.mode === 'independent' ? lead.binding.cwd : useWorkspaceStore.getState().rootDirectory);
  if (!open.length || lead.config.engine === 'shell' || (!lead.config.memoryKey && !directory)) return 0;
  const project = lead.config.memoryKey ?? await hubCall<string>({ action: 'memory-key', directory: directory! });
  for (const finding of open) {
    const content = [`Round Table finding ${finding.id} (${finding.severity}), ${finding.status}${finding.evidence ? `, at ${finding.evidence}` : ''}: ${finding.text}`, finding.response && `Driver: ${finding.response}`, finding.check && `Reviewer: ${finding.check}`, finding.reviewedAt && `Reviewed on files ${finding.reviewedAt}${finding.filesChanged ? ' (files changed while it was reviewed)' : ''}.`, 'Saved by Trace when the Round Table closed, because it was not verified.'].filter(Boolean).join('\n');
    await hubCall({ action: 'memory-write', project, title: itemTitle(`Round Table ${finding.id} (${finding.severity}, ${finding.status}): ${finding.text}`), content, author: 'human' });
  }
  return open.length;
}

async function retire(leadId: string) {
  if (retiring.has(leadId)) return; retiring.add(leadId);
  try {
    const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId);
    if (lead) await keepFindings(lead).catch(() => { /* The table still closes; its findings are lost only if memory cannot be written. */ });
    const partner = partnerOf(useWorkspaceStore.getState().sessions, leadId);
    if (partner && live(partner)) { await settled([partner.id], 'starting'); await stopSession(partner.id); await settled([partner.id]); }
    useWorkspaceStore.setState((state) => ({ sessions: state.sessions
      .filter((session) => session.id !== partner?.id || live(session))
      .map((session) => session.id === leadId && session.roundTable ? { ...session, roundTable: undefined } : session) }));
  } finally { retiring.delete(leadId); }
}
/** Leads whose table is being closed, so a close from the window and the host's `closed` event stop the partner once. */
const retiring = new Set<string>();

type TableRequest = { action: 'table-waiting'; send: boolean } | { action: 'table-send'; text: string; images: ChatImage[] } | { action: 'table-driver'; driver: 'claude' | 'codex' } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' };
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
  const saved = { partner: table.partner.sessionId, driver: table.driver, rounds: table.rounds, ...(table.findings?.length ? { findings: table.findings } : {}), ...(table.waiting !== undefined ? { waiting: table.waiting } : {}), ...(table.waitingImages?.length ? { waitingImages: table.waitingImages } : {}) };
  useWorkspaceStore.setState((state) => {
    const lead = state.sessions.find((session) => session.id === leadId);
    if (!lead || (lead.roundTable && JSON.stringify(lead.roundTable) === JSON.stringify(saved))) return {};
    return { sessions: state.sessions.map((session) => session.id === leadId ? { ...session, roundTable: saved } : session) };
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
    const pair = `${lead.runId}:${partner.runId}`; if (reopened.has(pair)) continue; reopened.add(pair);
    void window.codingHub?.chat({ action: 'table-open', sessionId: lead.id, runId: lead.runId, partner: { sessionId: partner.id, runId: partner.runId }, driver: lead.roundTable.driver, rounds: lead.roundTable.rounds, ...(lead.roundTable.findings?.length ? { findings: lead.roundTable.findings } : {}), ...(lead.roundTable.waiting !== undefined ? { waiting: lead.roundTable.waiting } : {}), ...(lead.roundTable.waitingImages?.length ? { waitingImages: lead.roundTable.waitingImages } : {}) }).catch(() => {});
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
