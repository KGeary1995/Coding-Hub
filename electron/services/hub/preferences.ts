import { z } from 'zod';
import { DEFAULT_PREFERENCES } from '../../../shared/hub';
import { tablePresetSchema } from '../../../shared/schemas';

/**
 * The Drive folder of a computer with no saved preferences: Google Drive for desktop's usual Windows folder, and none
 * elsewhere (a drive letter is no path on a Mac, and the folder differs per account). CODING_HUB_DEFAULT_DRIVE_DIR
 * replaces it (empty for none): unit tests and smokes set it, because where G:\My Drive\Coding Hub exists their fixture
 * notes and session summaries were mirrored into the person's real Drive.
 */
export function defaultDriveDirectory(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const chosen = env.CODING_HUB_DEFAULT_DRIVE_DIR; if (chosen !== undefined) return chosen;
  return platform === 'win32' ? DEFAULT_PREFERENCES.driveDirectory : '';
}

export const preferencesSchema = z.object({ folderId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), driveDirectory: z.string().max(4096), terminalFontSize: z.number().int().min(10).max(22), terminalWebGL: z.boolean().optional(), automaticMemory: z.boolean().optional(), resumeOnStart: z.boolean().optional(), syncDevices: z.boolean().optional(), alerts: z.boolean().optional(), dailyTokens: z.number().int().min(1).max(1e12).nullable().optional(), dailyCost: z.number().finite().min(0.01).max(1e6).nullable().optional(), limitWarning: z.number().int().min(50).max(99).optional(),
  /** The person's own Round Table presets (shared/table-seats.ts MAX_TABLE_PRESETS); kept per computer, not synced (device-sync picks its fields). */
  tablePresets: z.array(tablePresetSchema).max(20).optional(), prices: z.array(z.object({ model: z.string().min(1).max(120), input: z.number().finite().min(0).max(10000), output: z.number().finite().min(0).max(10000), cacheRead: z.number().finite().min(0).max(10000), cacheWrite: z.number().finite().min(0).max(10000) }).strict()).max(100) }).strict();
