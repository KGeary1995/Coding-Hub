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
export type UpdateRequest = { action: 'status' | 'check' | 'download' | 'install' | 'downloads' } | { action: 'automatic'; enabled: boolean };
/** The public page with every platform's installer. The app opens it; it never takes a URL from the renderer. */
export const DOWNLOADS_URL = 'https://github.com/KGeary1995/trace-releases/releases/latest';
