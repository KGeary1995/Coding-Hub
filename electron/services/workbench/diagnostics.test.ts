import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const discovery = vi.hoisted(() => ({ fresh: vi.fn(async () => ({ PATH: '/fresh' })), stale: vi.fn(() => ({ PATH: '/stale' })), discover: vi.fn(async (engine: string, _env: Record<string, string>) => ({ info: { engine, available: false, error: 'CLI not detected.' } })) }));
vi.mock('../cli/discovery', () => ({ freshHostEnvironment: discovery.fresh, hostEnvironment: discovery.stale, discoverEngine: discovery.discover }));
// No terminal is opened in a unit test: the probe reports failed.
vi.mock('../cli/native-pty', () => ({ nodePty: () => { throw new Error('No terminal in tests.'); } }));
import { Diagnostics } from './diagnostics';
import type { ClaudeProfiles } from '../cli/claude-profiles';

describe('diagnostics', () => {
  it('looks for the CLI with PATH read now, so one installed while Trace runs is found on the first try', async () => {
    const profiles = { environment: (base: Record<string, string>) => base } as unknown as ClaudeProfiles;
    const report = await new Diagnostics(profiles).execute({ action: 'diagnose', engine: 'codex', directory: null });
    expect(discovery.fresh).toHaveBeenCalled(); expect(discovery.stale).not.toHaveBeenCalled(); expect(discovery.discover.mock.calls[0][1]).toEqual({ PATH: '/fresh' });
    expect(report.steps[0]).toMatchObject({ name: 'CLI installation and flags', state: 'failed' });
  });
  it('names the project folder as chosen, not where a link leads, so the export can hide it', async () => {
    const profiles = { environment: (base: Record<string, string>) => base } as unknown as ClaudeProfiles;
    const chosen = process.cwd() + path.sep + '.';
    const report = await new Diagnostics(profiles).execute({ action: 'diagnose', engine: 'codex', directory: chosen });
    expect(report.steps.find((step) => step.name === 'Working folder')).toMatchObject({ state: 'passed', message: chosen });
  });
});
