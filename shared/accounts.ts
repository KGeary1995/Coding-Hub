export type AccountProvider = 'claude' | 'codex' | 'github';
export interface ClaudeAccountProfile { id: string; name: string; createdAt: string }
export interface AccountConnection {
  profileId?: string;
  provider: AccountProvider;
  installed: boolean;
  executable: string | null;
  version: string | null;
  state: 'authenticated' | 'not-authenticated' | 'unknown';
  message: string;
  canLogin: boolean;
  checkedAt: string;
}
export type AccountRequest = { action: 'status'; profileId?: string } | { action: 'profile-list' } | { action: 'profile-create'; name: string } | { action: 'profile-rename'; profileId: string; name: string } | { action: 'login'; provider: AccountProvider; profileId?: string; cols: number; rows: number } | { action: 'stop'; runId?: string } | { action: 'write'; runId: string; data: string } | { action: 'resize'; runId: string; cols: number; rows: number } | { action: 'install-guide'; provider: AccountProvider };
export interface AccountLogin { profileId?: string; runId: string; provider: AccountProvider }
export type AccountEvent = (AccountLogin & { type: 'started' }) | (AccountLogin & { type: 'data'; data: string }) | (AccountLogin & { type: 'exit'; exitCode: number });
export type AccountResponse = AccountConnection[] | ClaudeAccountProfile[] | ClaudeAccountProfile | AccountLogin | null;
