import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HubService } from './service';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

describe('installing project memory', () => {
  it('refuses a subfolder of a repository, where CLIs never read project MCP settings', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-service-'))); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project'); const sub = path.join(project, 'packages', 'app'); fs.mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: project });
    const hub = new HubService(path.join(root, 'hub')); cleanup.push(() => hub.close());
    expect(() => hub.execute({ action: 'memory-install', directory: sub })).toThrow("repository's top folder");
    expect(fs.existsSync(path.join(sub, '.mcp.json'))).toBe(false);
  });
});
