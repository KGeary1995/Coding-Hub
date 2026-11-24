/** An automatic check's state in a project folder (electron/services/workbench/auto-checks.ts), shown on its channels. */
export interface AutoCheckStatus {
  folder: string;
  /** The channel whose turn started it: a failure is sent back to it. */
  sessionId: string;
  state: 'running' | 'passed' | 'failed';
  /** The command running or failed; none once all passed. */
  command: string | null;
  summary: string;
  /** The end of a failed check's output. */
  output?: string;
  at: string;
}
