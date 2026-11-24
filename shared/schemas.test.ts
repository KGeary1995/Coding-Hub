import { describe, expect, it } from 'vitest';
import { channelConfigSchema, chatRequestSchema, engineConfigSchema, legacyWorkspaceSchema, modelValue, savedChainSchema, savedWorkspaceSchema, startSessionSchema } from './schemas';
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

describe('Gemini CLI channels, and the Gemini seat removed after 1.20', () => {
  it('a Gemini CLI channel can be started and configured, and so can a Gemini seat (1.20’s, back in 1.28)', () => {
    for (const config of [{ engine: 'gemini', model: 'gemini-4-argon-high' }, { engine: 'gemini', model: '', permissions: 'ask', resumeId: '11111111-1111-4111-8111-111111111111' }, { engine: 'gemini', model: 'gemini-4-argon-high', chat: true }]) {
      expect(channelConfigSchema.safeParse(config).success).toBe(true);
      expect(startSessionSchema.safeParse({ sessionId: 'g1', cwd: '/p', config, cols: 80, rows: 24 }).success).toBe(true);
    }
    for (const config of [{ engine: 'gemini', model: '--yolo' }, { engine: 'gemini', model: 'm', memoryKey: 'k' }]) expect(channelConfigSchema.safeParse(config).success).toBe(false);
  });
  it('a table request no longer names a Gemini seat; Continue leaves out a challenge, not Gemini', () => {
    const run = { sessionId: 's', runId: '11111111-1111-4111-8111-111111111111' };
    expect(chatRequestSchema.safeParse({ action: 'table-continue', ...run, skipChallenge: true }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ action: 'table-continue', ...run, skipGemini: true }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ action: 'table-open', ...run, partner: run, driver: 'claude', rounds: 2, kind: 'hierarchy', planner: run }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ action: 'table-open', ...run, partner: run, driver: 'claude', rounds: 2, kind: 'hierarchy', planner: run, challenger: run }).success).toBe(false);
    // From 1.39 a Gemini seat may drive.
    expect(chatRequestSchema.safeParse({ action: 'table-open', ...run, partner: run, driver: 'gemini', rounds: 2 }).success).toBe(true);
  });
  it('a workspace saved by 1.20 is refused as it is, but loads with its Gemini channel, without the seat, and the table at reviewing', () => {
    const saved = workspace120();
    expect(savedWorkspaceSchema.safeParse(saved).success).toBe(false);
    const legacy = legacyWorkspaceSchema.parse(saved);
    const { workspace, removedChannels } = migrateWorkspace(legacy);
    // The seat had no tile, so nothing the person saw is gone and the tiles stay where they were.
    expect(removedChannels).toBe(0);
    expect(savedWorkspaceSchema.safeParse(workspace).success).toBe(true);
    expect(workspace!.sessions.map((session) => session.id)).toEqual(['lead', 'rev', 'plan', 'gem']);
    expect(workspace!.sessions[3].config).toEqual({ engine: 'gemini', model: 'gemini-4-argon-high' });
    expect(workspace!.tiles).toEqual(saved.tiles); expect(workspace!.focusedSessionId).toBe('gem');
    const table = workspace!.sessions[0].roundTable!;
    expect(table).not.toHaveProperty('challenger');
    expect(table.chain).toEqual({ step: 'stopped', stoppedAt: 'reviewing', task: 'T', plan: 'P', report: 'R', reviewRound: 1, finalRound: 0, verdict: null, note: '', challenged: true });
    // 1.20's marks on findings are still read (nothing shows them).
    expect(table.findings).toMatchObject([{ id: 'F1', source: 'gemini' }, { id: 'F2', gemini: 'dispute' }, { id: 'F3', duplicateOf: 'F1' }]);
  });
  it('a chain saved at Gemini’s review becomes reviewing; a workspace of one Gemini channel loads as it is', () => {
    const saved = workspace120(); saved.sessions[0].roundTable!.chain = { ...saved.sessions[0].roundTable!.chain, step: 'second-reviewing' } as never;
    delete (saved.sessions[0].roundTable!.chain as Record<string, unknown>).stoppedAt;
    expect(migrateWorkspace(legacyWorkspaceSchema.parse(saved)).workspace!.sessions[0].roundTable!.chain!.step).toBe('reviewing');
    const only = { ...workspace120(), sessions: [workspace120().sessions[4]], tiles: [{ ...workspace120().tiles[1], x: 0 }], focusedSessionId: null };
    expect(migrateWorkspace(legacyWorkspaceSchema.parse(only))).toEqual({ workspace: only, removedChannels: 0, rootDirectory: '/p' });
  });
  it('keeps a Gemini chat that has a tile (from 1.39 one leads a table); drops 1.20’s seat even with a tile, and lays the rest out again', () => {
    const kept = workspace120(); (kept.sessions[4].config as Record<string, unknown>).chat = true;
    const own = migrateWorkspace(legacyWorkspaceSchema.parse(kept));
    expect(own.removedChannels).toBe(0); expect(own.workspace!.sessions.find((session) => session.id === 'gem')!.config).toMatchObject({ engine: 'gemini', chat: true });
    const saved = workspace120(); saved.tiles.push({ sessionId: 'seat', x: 8, y: 0, w: 4, h: 12, minW: 3, minH: 10 });
    const { workspace, removedChannels } = migrateWorkspace(legacyWorkspaceSchema.parse(saved));
    expect(removedChannels).toBe(1); expect(workspace!.tiles.map((tile) => tile.sessionId)).toEqual(['lead', 'gem']);
  });
});

describe('a hierarchy chain planning again after the final review', () => {
  const chain = { step: 'planning', task: 'T', plan: 'P', report: 'R', reviewRound: 0, finalRound: 0, verdict: null, note: '' };
  it('loads with its final review request, and without one as before', () => {
    expect(savedChainSchema.parse({ ...chain, replan: 'rename it' }).replan).toBe('rename it');
    expect(savedChainSchema.parse({ ...chain, replan: '' }).replan).toBe('');
    expect(savedChainSchema.parse(chain)).not.toHaveProperty('replan');
    expect(savedChainSchema.safeParse({ ...chain, replan: 'x'.repeat(20_001) }).success).toBe(false);
  });
});

describe('a hierarchy chain with tasks from Tasks waiting', () => {
  const chain = { step: 'final', task: 'T', plan: 'P', report: 'R', reviewRound: 0, finalRound: 0, verdict: null, note: '' };
  it('loads them, and at most ten', () => {
    expect(savedChainSchema.parse({ ...chain, nextTasks: ['Task: B.'], held: 'Too long.' })).toMatchObject({ nextTasks: ['Task: B.'], held: 'Too long.' });
    expect(savedChainSchema.safeParse({ ...chain, nextTasks: Array.from({ length: 11 }, () => 'Task: B.') }).success).toBe(false);
    expect(savedChainSchema.safeParse({ ...chain, nextTasks: [''] }).success).toBe(false);
  });
});

describe('a hierarchy chain revising a plan', () => {
  const chain = { step: 'planning', task: 'T', plan: 'P', report: 'R', reviewRound: 0, finalRound: 0, verdict: null, note: '' };
  it('loads with the note, and without one as before', () => {
    expect(savedChainSchema.parse({ ...chain, revision: 'Use the helper.' }).revision).toBe('Use the helper.');
    expect(savedChainSchema.parse(chain)).not.toHaveProperty('revision');
    expect(savedChainSchema.safeParse({ ...chain, revision: 'x'.repeat(410_001) }).success).toBe(false);
  });
});

describe('dropping a task from Tasks waiting at a hierarchy table', () => {
  const run = { sessionId: 's', runId: '11111111-1111-4111-8111-111111111111' };
  it('takes an index of 0 to 9 and the start of the task as shown', () => {
    expect(chatRequestSchema.safeParse({ action: 'table-next-drop', ...run, index: 0, head: 'Task: B.' }).success).toBe(true);
    for (const bad of [{ index: 10, head: 'Task: B.' }, { index: -1, head: 'Task: B.' }, { index: 1.5, head: 'Task: B.' }, { index: 0, head: '' }, { index: 0, head: 'x'.repeat(201) }]) expect(chatRequestSchema.safeParse({ action: 'table-next-drop', ...run, ...bad }).success).toBe(false);
  });
});
