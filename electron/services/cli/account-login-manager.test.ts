import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProfiles } from './claude-profiles';
import { describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { AccountEvent, AccountProvider } from '../../../shared/accounts';
import { AccountLoginManager } from './account-login-manager';
import { githubAuthentication, LOGIN_ARGUMENTS } from './account-connections';
class FakePty {
  pid = 99999999; data = (_value: string) => {}; exit = (_value: { exitCode: number }) => {};
  write = vi.fn(); resize = vi.fn(); kill = vi.fn(() => queueMicrotask(() => this.exit({ exitCode: 1 })));
  onData(listener: typeof this.data) { this.data = listener; return { dispose() {} }; }
  onExit(listener: typeof this.exit) { this.exit = listener; return { dispose() {} }; }
}
function discovery(provider: AccountProvider, installed = true) {
  return { connection: { provider, installed, executable: installed ? '/official-cli' : null, version: '2.0.0', state: 'not-authenticated' as const, message: installed ? 'Sign in.' : 'Install the CLI.', canLogin: installed, checkedAt: new Date().toISOString() }, executable: installed ? { file: '/official-cli', prefixArgs: [], extraEnv: {}, displayPath: '/official-cli' } : null };
}
function fixture(inspect = async (provider: AccountProvider) => discovery(provider)) {
  const pty = new FakePty(); const spawn = vi.fn(() => pty as unknown as IPty); const events: AccountEvent[] = []; const openGuide = vi.fn(async () => {});
  const manager = new AccountLoginManager((_owner, event) => events.push(event), { stopDependencies: { platform: 'linux', signalGroup: () => {} }, inspect, spawn, openGuide });
  return { manager, pty, spawn, events, openGuide };
}
describe('account setup independent of project sessions', () => {
  it('starts only official login arguments, routes private input/output, and cancels without session storage', async () => {
    const { manager, pty, spawn, events } = fixture();
    const login = await manager.execute(7, { action: 'login', provider: 'claude', cols: 80, rows: 24 });
    expect(login && !Array.isArray(login) && 'runId' in login).toBe(true);
    const runId = (login as { runId: string }).runId;
    expect(spawn.mock.calls[0][1]).toEqual(LOGIN_ARGUMENTS.claude); expect(manager.active).toBe(true);
    pty.data('Private one-time login code');
    await manager.execute(7, { action: 'write', runId, data: 'confirm\r' }); expect(pty.write).toHaveBeenCalledWith('confirm\r');
    await expect(manager.execute(8, { action: 'write', runId, data: 'bad' })).rejects.toMatchObject({ code: 'STALE_LOGIN' });
    await expect(manager.execute(7, { action: 'login', provider: 'codex', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'LOGIN_BUSY' });
    await manager.execute(7, { action: 'stop', runId }); expect(manager.active).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['started', 'data', 'exit']);
    await expect(manager.execute(7, { action: 'write', runId, data: 'bad' })).rejects.toMatchObject({ code: 'STALE_LOGIN' });
    await manager.close();
  });
  it('cancels pending discovery before spawning and refuses missing CLIs or untrusted request fields', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, spawn } = fixture(async (provider) => { await gate; return discovery(provider); });
    const pending = manager.execute(7, { action: 'login', provider: 'github', cols: 80, rows: 24 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' });
    await manager.execute(7, { action: 'stop' }); release(); await rejection; expect(spawn).not.toHaveBeenCalled();
    await expect(manager.execute(7, { action: 'login', provider: 'codex', command: 'arbitrary', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_REQUEST' });
    const missing = fixture(async (provider) => discovery(provider, false));
    await expect(missing.manager.execute(7, { action: 'login', provider: 'codex', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'LOGIN_UNAVAILABLE' });
    expect(missing.spawn).not.toHaveBeenCalled(); await manager.close(); await missing.manager.close();
  });
  it('routes named login and authentication checks through one isolated directory and blocks reconnecting an active profile', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-login-profile-'));
    const profiles = new ClaudeProfiles(root); const profile = profiles.create('Work');
    const pty = new FakePty(); const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => pty as unknown as IPty);
    const inspect = vi.fn(async (provider: AccountProvider, _env?: Record<string, string>) => discovery(provider));
    let inUse = false;
    const manager = new AccountLoginManager(() => {}, { profiles, profileInUse: () => inUse, inspect, spawn, openGuide: async () => {}, stopDependencies: { platform: 'linux', signalGroup: () => {} } });
    try {
      const login = await manager.execute(7, { action: 'login', provider: 'claude', profileId: profile.id, cols: 80, rows: 24 });
      expect(login).toMatchObject({ profileId: profile.id });
      expect(spawn.mock.calls[0][2]).toMatchObject({ env: { CLAUDE_CONFIG_DIR: profiles.directory(profile.id) } });
      expect(inspect.mock.calls[0][1]?.CLAUDE_CONFIG_DIR).toBe(profiles.directory(profile.id));
      await manager.stopOwner(7);
      await manager.execute(7, { action: 'status', profileId: profile.id });
      expect(inspect.mock.calls.filter(([provider]) => provider === 'claude').at(-1)?.[1]?.CLAUDE_CONFIG_DIR).toBe(profiles.directory(profile.id));
      inUse = true;
      await expect(manager.execute(7, { action: 'login', provider: 'claude', profileId: profile.id, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'PROFILE_BUSY' });
      await expect(manager.execute(7, { action: 'login', provider: 'codex', profileId: profile.id, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_REQUEST' });
    } finally { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps GitHub status redacted and opens only fixed official installation guides', async () => {
    expect(githubAuthentication('', 'Logged in to github.com account private-user (keyring)\nToken: private-token', 0)).toBe('authenticated');
    expect(githubAuthentication('', 'You are not logged into any GitHub hosts', 1)).toBe('not-authenticated');
    expect(githubAuthentication('', 'Logged in to github.com\nThe token is invalid', 1)).toBe('not-authenticated');
    expect(githubAuthentication('', 'Network unreachable', 1)).toBe('unknown');
    const { manager, openGuide } = fixture(); await manager.execute(7, { action: 'install-guide', provider: 'github' }); expect(openGuide).toHaveBeenCalledWith('https://cli.github.com/');
    await expect(manager.execute(7, { action: 'install-guide', provider: 'github', url: 'file:///private' })).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_REQUEST' }); await manager.close();
  });
});

it('keeps login cleanup reliable when native event delivery fails',async()=>{
 const pty=new FakePty(), failures=vi.fn();const manager=new AccountLoginManager(()=>{throw new Error('Renderer disappeared');},{inspect:async provider=>discovery(provider),spawn:()=>pty as unknown as IPty,openGuide:async()=>{},onEventError:failures,stopDependencies:{platform:'linux',signalGroup:()=>{}}});
 try{await expect(manager.execute(7,{action:'login',provider:'claude',cols:80,rows:24})).resolves.toMatchObject({provider:'claude'});expect(()=>pty.data('Private login output')).not.toThrow();await manager.stopOwner(7);expect(manager.active).toBe(false);expect(failures).toHaveBeenCalled();}finally{await manager.close();}
});
