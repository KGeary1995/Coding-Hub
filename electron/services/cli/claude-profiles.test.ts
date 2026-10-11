import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProfiles } from './claude-profiles';
import { engineConfigSchema } from '../../../shared/schemas';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profiles-')); roots.push(root); return { root, store: new ClaudeProfiles(root) }; }
describe('isolated local Claude profiles', () => {
  it('persists stable profile IDs and labels without touching existing credentials', () => {
    const { store, root } = fixture();
    const legacy = path.join(root, 'legacy'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, '.credentials.json'), 'private-default');
    const personal = store.create('Personal'); const work = store.create('Work');
    expect(store.directory(personal.id)).not.toBe(store.directory(work.id));
    expect(fs.readdirSync(store.directory(personal.id))).toEqual([]);
    expect(new ClaudeProfiles(root).list()).toEqual([personal, work]);
    store.rename(personal.id, 'Home'); expect(store.list()[0]).toMatchObject({ id: personal.id, name: 'Home' });
    expect(fs.readFileSync(path.join(legacy, '.credentials.json'), 'utf8')).toBe('private-default');
    expect(fs.readFileSync(path.join(root, 'claude-profiles/profiles.json'), 'utf8')).not.toContain('private-default');
    if (process.platform !== 'win32') expect(fs.statSync(store.directory(work.id)).mode & 0o777).toBe(0o700);
  });
  it('preserves the default environment but removes authentication overrides from named sessions without mutating the host', () => {
    const { store } = fixture(); const profile = store.create('Work');
    const base = { PATH: '/bin', TOOL_FLAG: 'keep', CLAUDE_CONFIG_DIR: '/legacy', ANTHROPIC_API_KEY: 'secret', anthropic_auth_token: 'secret', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9', CLAUDE_CODE_USE_BEDROCK: '1' };
    expect(store.environment(base)).toEqual(base);
    const isolated = store.environment(base, profile.id);
    expect(isolated).toEqual({ PATH: '/bin', TOOL_FLAG: 'keep', CLAUDE_CONFIG_DIR: store.directory(profile.id) });
    expect(base.ANTHROPIC_API_KEY).toBe('secret');
    expect(() => store.environment(base, '../escape')).toThrow('unavailable');
    expect(() => store.environment(base, '11111111-1111-4111-8111-111111111111')).toThrow('unavailable');
  });
  it('preserves invalid registries and rejects duplicate labels and redirected configuration paths', () => {
    const { store, root } = fixture(); const profile = store.create('Work');
    expect(() => store.create(' work ')).toThrow('unique'); expect(() => store.create('')).toThrow('name');
    if (process.platform !== 'win32') {
      const directory = store.directory(profile.id); fs.rmdirSync(directory); fs.symlinkSync(root, directory, 'dir');
      expect(() => store.directory(profile.id)).toThrow('link');
    }
    const file = path.join(root, 'claude-profiles/profiles.json'); fs.writeFileSync(file, '{corrupt');
    expect(() => store.create('Another')).toThrow('preserved'); expect(fs.readFileSync(file, 'utf8')).toBe('{corrupt');
  });
  it('stores account selection only on Claude settings and validates profile IDs', () => {
    const config = { engine: 'claude', model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } };
    const id = '11111111-1111-4111-8111-111111111111';
    expect(engineConfigSchema.parse({ ...config, accountProfileId: id })).toHaveProperty('accountProfileId', id);
    expect(engineConfigSchema.safeParse({ ...config, accountProfileId: '/tmp/private' }).success).toBe(false);
    expect(engineConfigSchema.safeParse({ engine: 'codex', model: '', reasoningEffort: null, accountProfileId: id }).success).toBe(false);
  });
});
