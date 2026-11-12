import { describe, expect, it } from 'vitest';
import { channelConfigSchema, chatRequestSchema, engineConfigSchema, legacyWorkspaceSchema, modelValue, savedWorkspaceSchema, startSessionSchema } from './schemas';
import { migrateWorkspace } from './workspace-migration';
import { workspace120 } from './workspace-120.fixture';

describe('engine model settings', () => {
  it('accepts Claude Code context-suffixed aliases and still refuses flag-like values', () => {
    const config = (model: string) => engineConfigSchema.safeParse({ engine: 'claude', model, thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } }).success;
    expect(config('sonnet[1m]')).toBe(true); expect(config('claude-sonnet-4-5[1m]')).toBe(true);
    expect(config('--dangerously-skip-permissions')).toBe(false); expect(config('model & calc')).toBe(false);
  });
  it('only lets the UI store model text the saved workspace accepts', () => {
    expect(modelValue(' gpt-5 ')).toBe('gpt-5'); expect(modelValue('')).toBe('');
    expect(modelValue('two words')).toBeNull(); expect(modelValue('-flag')).toBeNull(); expect(modelValue('x'.repeat(161))).toBeNull();
  });
});

describe('Gemini, removed after 1.20', () => {
  it('cannot be started or configured any more', () => {
    for (const config of [{ engine: 'gemini', model: 'gemini-4-argon-high' }, { engine: 'gemini', model: 'gemini-4-argon-high', chat: true }]) {
      expect(channelConfigSchema.safeParse(config).success).toBe(false);
      expect(startSessionSchema.safeParse({ sessionId: 'g1', cwd: '/p', config, cols: 80, rows: 24 }).success).toBe(false);
    }
    expect(engineConfigSchema.safeParse({ engine: 'gemini', model: 'gemini-4-argon-high' }).success).toBe(false);
  });
  it('a table request no longer names a Gemini seat; Continue leaves out a challenge, not Gemini', () => {
    const run = { sessionId: 's', runId: '11111111-1111-4111-8111-111111111111' };
    expect(chatRequestSchema.safeParse({ action: 'table-continue', ...run, skipChallenge: true }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ action: 'table-continue', ...run, skipGemini: true }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ action: 'table-open', ...run, partner: run, driver: 'claude', rounds: 2, kind: 'hierarchy', planner: run }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ action: 'table-open', ...run, partner: run, driver: 'claude', rounds: 2, kind: 'hierarchy', planner: run, challenger: run }).success).toBe(false);
  });
  it('a workspace saved by 1.20 is refused as it is, but loads and becomes one with no Gemini, no challenger and step reviewing', () => {
    const saved = workspace120();
    expect(savedWorkspaceSchema.safeParse(saved).success).toBe(false);
    const legacy = legacyWorkspaceSchema.parse(saved);
    const { workspace, removedChannels } = migrateWorkspace(legacy);
    expect(removedChannels).toBe(1);
    expect(savedWorkspaceSchema.safeParse(workspace).success).toBe(true);
    expect(workspace!.sessions.map((session) => session.id)).toEqual(['lead', 'rev', 'plan']);
    expect(workspace!.tiles.map((tile) => tile.sessionId)).toEqual(['lead']); expect(workspace!.focusedSessionId).toBeNull();
    const table = workspace!.sessions[0].roundTable!;
    expect(table).not.toHaveProperty('challenger');
    expect(table.chain).toEqual({ step: 'stopped', stoppedAt: 'reviewing', task: 'T', plan: 'P', report: 'R', reviewRound: 1, finalRound: 0, verdict: null, note: '', challenged: true });
    // 1.20's marks on findings are still read (nothing shows them).
    expect(table.findings).toMatchObject([{ id: 'F1', source: 'gemini' }, { id: 'F2', gemini: 'dispute' }, { id: 'F3', duplicateOf: 'F1' }]);
  });
  it('a chain saved at Gemini\'s review becomes reviewing; a workspace of Gemini channels only leaves nothing', () => {
    const saved = workspace120(); saved.sessions[0].roundTable!.chain = { ...saved.sessions[0].roundTable!.chain, step: 'second-reviewing' } as never;
    delete (saved.sessions[0].roundTable!.chain as Record<string, unknown>).stoppedAt;
    expect(migrateWorkspace(legacyWorkspaceSchema.parse(saved)).workspace!.sessions[0].roundTable!.chain!.step).toBe('reviewing');
    const only = { ...workspace120(), sessions: [workspace120().sessions[4]], tiles: [{ ...workspace120().tiles[1], x: 0 }], focusedSessionId: null };
    expect(migrateWorkspace(legacyWorkspaceSchema.parse(only))).toEqual({ workspace: null, removedChannels: 1, rootDirectory: '/p' });
  });
});
