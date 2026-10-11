export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'installing' | 'error';
export interface UpdateStatus {
  phase: UpdatePhase;
  version: string;
  availableVersion: string | null;
  progress: number | null;
  lastChecked: string | null;
  automaticChecks: boolean;
  message: string;
}
export type UpdateRequest = { action: 'status' | 'check' | 'download' | 'install' } | { action: 'automatic'; enabled: boolean };
