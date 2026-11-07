import { MAX_CHANNELS } from '../../shared/schemas';
import type { ChatImage, RoundTableState } from '../../shared/chat';
import { useWorkspaceStore } from '../state/workspace-store';
import { useChatStore } from '../state/chat-store';
import { startSession } from './use-native-host';

const NAME = { claude: 'Claude Code', codex: 'Codex' } as const;
/** Rounds a new table discusses after each message: both answer, then each replies to the other twice at most. */
export const DEFAULT_ROUNDS = 2;

/** The Round Table a chat channel leads, if any. */
export const tableOf = (sessionId: string): RoundTableState | null => useChatStore.getState().threads[sessionId]?.table ?? null;

/**
 * Seats the other agent at a running chat channel's Round Table: a new chat channel of the other engine in the same
 * folder, started, then joined to this one. The channel it was opened from leads; its agent drives first.
 */
export async function openRoundTable(leadId: string): Promise<string | null> {
  const workspace = useWorkspaceStore.getState(); const lead = workspace.sessions.find((session) => session.id === leadId);
  if (!lead || lead.config.engine === 'shell' || !lead.config.chat || lead.status !== 'running' || !lead.runId || !lead.runningCwd) return 'Start this chat first.';
  if (tableOf(leadId)) return null;
  if (workspace.sessions.length >= MAX_CHANNELS) return `Close a channel first: a Round Table adds ${NAME[lead.config.engine === 'claude' ? 'codex' : 'claude']} as a channel, and eight is the most.`;
  const engine = lead.config.engine === 'claude' ? 'codex' as const : 'claude' as const;
  workspace.addSession(engine);
  const partner = useWorkspaceStore.getState().sessions.at(-1);
  if (!partner || partner.config.engine !== engine) return 'The channel could not be added.';
  // The same folder the leading chat runs in, whatever the workspace root is now.
  useWorkspaceStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === partner.id && session.config.engine !== 'shell' ? { ...session, binding: { mode: 'independent', cwd: lead.runningCwd! }, config: { ...session.config, chat: true } } : session) }));
  await startSession(partner.id);
  const started = useWorkspaceStore.getState().sessions.find((session) => session.id === partner.id);
  if (!started || started.status !== 'running' || !started.runId) return started?.error ?? `${NAME[engine]} could not be started.`;
  const result = await window.codingHub?.chat({ action: 'table-open', sessionId: lead.id, runId: lead.runId, partner: { sessionId: started.id, runId: started.runId }, driver: lead.config.engine, rounds: DEFAULT_ROUNDS }).catch(() => null);
  return result?.ok ? null : result?.error.message ?? 'The Round Table could not be opened.';
}

type TableRequest = { action: 'table-send'; text: string; images: ChatImage[] } | { action: 'table-driver'; driver: 'claude' | 'codex' } | { action: 'table-rounds'; rounds: number } | { action: 'table-stop' } | { action: 'table-close' };
/** A request to the table a running chat channel leads; the error message, or null. */
export async function tableRequest(leadId: string, request: TableRequest): Promise<string | null> {
  const lead = useWorkspaceStore.getState().sessions.find((session) => session.id === leadId);
  if (!lead?.runId || !window.codingHub) return 'This chat is not running.';
  const result = await window.codingHub.chat({ ...request, sessionId: lead.id, runId: lead.runId }).catch(() => null);
  return result?.ok ? null : result?.error.message ?? 'Trace could not reach the Round Table.';
}

/** The leading channel remembers its table (partner, driver, rounds) whenever the table changes. */
export function rememberTable(leadId: string, table: RoundTableState) {
  const saved = { partner: table.partner.sessionId, driver: table.driver, rounds: table.rounds };
  useWorkspaceStore.setState((state) => {
    const lead = state.sessions.find((session) => session.id === leadId);
    if (!lead || (lead.roundTable && lead.roundTable.partner === saved.partner && lead.roundTable.driver === saved.driver && lead.roundTable.rounds === saved.rounds)) return {};
    return { sessions: state.sessions.map((session) => session.id === leadId ? { ...session, roundTable: saved } : session) };
  });
}
/** Closing the table (the person's choice, not Trace quitting) forgets it, so it is not opened again. */
export function forgetTable(leadId: string) {
  useWorkspaceStore.setState((state) => state.sessions.some((session) => session.id === leadId && session.roundTable) ? { sessions: state.sessions.map((session) => session.id === leadId ? { ...session, roundTable: undefined } : session) } : {});
}
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
    if (!lead.roundTable || lead.status !== 'running' || !lead.runId || tableOf(lead.id)) continue;
    const partner = sessions.find((session) => session.id === lead.roundTable!.partner);
    if (!partner || partner.status !== 'running' || !partner.runId) continue;
    const pair = `${lead.runId}:${partner.runId}`; if (reopened.has(pair)) continue; reopened.add(pair);
    void window.codingHub?.chat({ action: 'table-open', sessionId: lead.id, runId: lead.runId, partner: { sessionId: partner.id, runId: partner.runId }, driver: lead.roundTable.driver, rounds: lead.roundTable.rounds }).catch(() => {});
  }
}
