/** Undo last turn (1.39.0) for one agent channel, as the host knows it (electron/services/repository/turn-snapshots.ts). */
export interface UndoStatus {
  sessionId: string;
  /** False when the channel's folder is not a Git repository (or the agent is a shell): `reason` says why. */
  available: boolean;
  /** A turn changed files since the channel started: its files can be put back. */
  canUndo: boolean;
  /** The last undo can be taken back (no files changed since). */
  canRedo: boolean;
  reason?: string;
}
/** What Undo or Redo would do, for its confirmation: how many files change, and the other channels in that folder. */
export interface UndoPreview { files: number; others: string[] }
/** What Undo or Redo did. */
export interface UndoResult { files: number; status: UndoStatus }
