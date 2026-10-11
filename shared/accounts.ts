export type AccountProvider = 'claude' | 'codex' | 'github';
export interface AccountConnection {
  provider: AccountProvider;
  installed: boolean;
  executable: string | null;
  version: string | null;
  state: 'authenticated' | 'not-authenticated' | 'unknown';
  message: string;
  canLogin: boolean;
  checkedAt: string;
}
export type AccountRequest = { action: 'status' } | { action: 'login'; provider: AccountProvider; cols: number; rows: number } | { action: 'stop'; runId?: string } | { action: 'write'; runId: string; data: string } | { action: 'resize'; runId: string; cols: number; rows: number } | { action: 'install-guide'; provider: AccountProvider };
export interface AccountLogin { runId: string; provider: AccountProvider }
export type AccountEvent = (AccountLogin & { type: 'started' }) | (AccountLogin & { type: 'data'; data: string }) | (AccountLogin & { type: 'exit'; exitCode: number });
export type AccountResponse = AccountConnection[] | AccountLogin | null;
