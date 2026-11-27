import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HeldMeta } from '../cli/pty-manager';
import { HerdrTerminals } from './herdr';

// Against a real herdr-core: CODING_HUB_TEST_HC=<absolute path to hc>. Skipped otherwise (CI has no hc).
const hc = process.env.CODING_HUB_TEST_HC;
// A shell to drive: sh on a Mac or Linux, Windows PowerShell on Windows (no tput there: the console's own width).
const windows = process.platform === 'win32';
const shell = windows ? { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], width: '$($Host.UI.RawUI.WindowSize.Width)' } : { file: '/bin/sh', args: [], width: '$(tput cols)' };
const until = async (check: () => boolean, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (check()) return true; return check(); };

describe.skipIf(!hc)('channels held by herdr-core (trial)', () => {
  it('starts a channel\'s terminal, types and resizes, is taken up again by a Trace that opened again, and stops', { timeout: 60_000 }, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-herdr-')); const sessionId = randomUUID(); const runId = randomUUID();
    const meta = { session: { sessionId, runId, engine: 'shell', cwd, pid: 0 }, config: { engine: 'shell' } } as unknown as HeldMeta;
    const first = new HerdrTerminals(hc!); first.meta = () => ({ attention: 'token-a' });
    try {
      const pty = await first.spawn(shell.file, shell.args, { cwd, cols: 90, rows: 20, env: { ...process.env, PS1: '$ ', TRACE_TRIAL: 'yes' } as Record<string, string> }, meta);
      let seen = ''; pty.onData((text) => { seen += text; });
      expect(pty.pid).toBeGreaterThan(0);
      pty.write(windows ? `echo "$env:TRACE_TRIAL ${shell.width}"\r` : `echo "$TRACE_TRIAL ${shell.width}"\r`);
      expect(await until(() => /yes 90/.test(seen))).toBe(true);
      pty.resize(70, 20); await new Promise((resolve) => setTimeout(resolve, 300)); pty.write(`echo "width ${shell.width}"\r`);
      expect(await until(() => /width 70\b/.test(seen))).toBe(true);
      // Trace closes (lets go of hc); the shell keeps running.
      first.close();
      const again = new HerdrTerminals(hc!);
      try {
        expect(await again.kept()).toContain(sessionId);
        const taken = await again.take(sessionId); expect(taken).not.toBeNull();
        expect(taken!.meta).toMatchObject({ session: { sessionId, runId }, attention: 'token-a' });
        expect(taken!.pty.pid).toBe(pty.pid);
        let after = ''; taken!.pty.onData((text) => { after += text; }); taken!.pty.write('echo still-here\r');
        expect(await until(() => after.includes('still-here'))).toBe(true);
        const exited = new Promise<{ exitCode: number }>((resolve) => taken!.pty.onExit(resolve)); taken!.pty.write('exit 3\r');
        expect((await exited).exitCode).toBe(3);
        expect(await new HerdrTerminals(hc!).kept()).not.toContain(sessionId);
      } finally { again.close(); }
    } finally { first.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
