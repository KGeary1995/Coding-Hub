import type { CLIEngine, MCPConfig, LocalExtension } from './types';

export interface ConfigInventory { servers: MCPConfig[]; extensions: (LocalExtension & { preview: string; enabled: boolean | null })[]; warnings: string[] }
export type HubRequest =
  | { action: 'rules-read'; directories: string[] }
  | { action: 'rules-save'; content: string; revision: string; targets: RulesTargetReference[] }
  | { action: 'inventory'; directory: string | null }
  | { action: 'toggle-server'; id: string; enabled: boolean }
  | { action: 'remove-server'; id: string }
  | { action: 'add-server'; directory: string | null; engine: CLIEngine; scope: 'user' | 'project'; name: string; command: string; args: string[]; envNames: string[]; url?: string }
  | { action: 'toggle-extension'; id: string; enabled: boolean }
  | { action: 'drive-conflicts'; project: string }
  | { action: 'drive-resolve'; project: string; id: string; localHash: string; remoteHash: string }
  | { action: 'memory-list'; project: string }
  | { action: 'memory-key'; directory: string }
  | { action: 'memory-write'; project: string; title: string; content: string; author: CLIEngine | 'human'; supersedes?: string }
  | { action: 'memory-install'; directory: string; project: string }
  | { action: 'usage' }
  | { action: 'preferences' }
  | { action: 'save-preferences'; preferences: HubPreferences }
  | { action: 'drive-connect' }
  | { action: 'drive-disconnect' }
  | { action: 'drive-status' }
  | { action: 'device-sync-status' }
  | { action: 'device-sync-now' }
  | { action: 'device-sync-resolve'; document: SyncedDocument; keep: 'local' | 'remote' }
  | { action: 'drive-sync'; project: string };
export interface MemoryNote { id: string; project: string; title: string; content: string; author: CLIEngine | 'human'; createdAt: string; supersedes?: string }
export interface MemoryConflict { id: string; local: MemoryNote; remote: MemoryNote; localHash: string; remoteHash: string }
/** `machine` names the other computer a record was synced from; it is absent for this computer's own runs. */
export interface UsageRecord { machine?: string; conversationId?: string; source?: 'claude-session-jsonl' | 'codex-rollout-jsonl'; confidence?: 'reported'; costBasis?: 'configured-model-rates' | 'unpriced'; eventCount?: number; runId: string; sessionId: string; engine: CLIEngine; model: string; cwd: string; timestamp: string; input: number; output: number; cached: number; cacheWrite: number; reasoning: number | null; context: { used: number; limit: number } | null; cost: number | null }
export interface PriceRate { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface HubPreferences { folderId: string; driveDirectory: string; prices: PriceRate[]; terminalFontSize: number; terminalWebGL?: boolean; automaticMemory?: boolean; syncDevices?: boolean }
export type SyncedDocument = 'settings' | 'rules';
export interface SyncedComputer { id: string; name: string; updatedAt: string }
export interface DeviceSyncStatus { enabled: boolean; connected: boolean; machine: { id: string; name: string }; lastSync: string | null; error: string | null; computers: SyncedComputer[]; conflicts: { document: SyncedDocument; from: string; at: string }[]; rulesFrom: { name: string; at: string } | null }
export interface DriveStatus { connected: boolean; clientConfigured: boolean; persistent: boolean; folderId: string }
export interface RulesTargetReference { directory: string; claudeHash: string; codexHash: string }
export interface RulesTarget extends RulesTargetReference { applied: boolean; error?: string }
export interface SharedRules { content: string; revision: string; directories: string[]; targets: RulesTarget[] }
export type HubResponse = MemoryConflict[] | SharedRules | ConfigInventory | MemoryNote[] | MemoryNote | UsageRecord[] | HubPreferences | DriveStatus | DeviceSyncStatus | string | { uploaded: number; downloaded: number } | null;
export const DEFAULT_DRIVE_FOLDER = '1X057crI-PHRV3ie1tl5btF4bUbuhxzwM';
export const DEFAULT_PREFERENCES: HubPreferences = { folderId: DEFAULT_DRIVE_FOLDER, driveDirectory: 'G:\\My Drive\\Coding Hub', terminalFontSize: 13, terminalWebGL: false, automaticMemory: true, prices: [] };
