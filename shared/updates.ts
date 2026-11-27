export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'installing' | 'error';
export interface UpdateStatus {
  phase: UpdatePhase;
  version: string;
  availableVersion: string | null;
  progress: number | null;
  lastChecked: string | null;
  /** Automatic checks also download what they find (1.51.0). */
  automaticChecks: boolean;
  /** A downloaded update installs when Trace quits (1.51.0; on a Mac only with no channel kept running). */
  installOnQuit: boolean;
  message: string;
}
export type UpdateRequest = { action: 'status' | 'check' | 'download' | 'install' | 'downloads' } | { action: 'automatic' | 'install-on-quit'; enabled: boolean };
/** The public page with every platform's installer. The app opens it; it never takes a URL from the renderer. */
export const DOWNLOADS_URL = 'https://github.com/KGeary1995/trace-releases/releases/latest';
