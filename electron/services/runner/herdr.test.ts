import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HeldMeta } from '../cli/pty-manager';
import { docName, HerdrPty, HerdrTerminals } from './herdr';

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
    } finally { first.close(); fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  });
});

describe('a herdr-core terminal (no hc needed)', () => {
  it('keeps its details under a name hc takes for any run id (one like t9ff… was taken for an address)', () => {
    for (const runId of ['9ff84db7-5c1c-465c-96b1-7f2d1bc7c75a', 'a0230e3a-e8c1-4ebb-b41d-f49dff53356f']) expect(docName(runId)).toMatch(/^trace-[0-9a-f]{26}$/);
  });
  it('tells an exit that came before anyone listened to the first listener (while a channel was being taken up)', async () => {
    const pty = new HerdrPty({ connect: () => Promise.reject(new Error('unused')), sized: () => {}, problem: () => {} }, 't1', 5, 80, 24);
    pty.wrote('last screen'); pty.end({ exitCode: 4 });
    let seen = ''; pty.onData((text) => { seen += text; }); const exit = await new Promise((resolve) => pty.onExit(resolve));
    expect(exit).toEqual({ exitCode: 4 }); expect(seen).toBe('last screen');
  });
});

// Codex's audit of the trial (2026-11-27), each against a real hc.
describe.skipIf(!hc)('herdr-core terminals, what an audit found', () => {
  const meta = (cwd: string) => ({ session: { sessionId: randomUUID(), runId: randomUUID(), engine: 'shell', cwd, pid: 0 }, config: { engine: 'shell' } }) as unknown as HeldMeta;
  const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trace-herdr-'));
  const remove = (cwd: string) => fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  it.skipIf(windows)('does not give a program a variable Trace left out, though hc\'s own environment has it', { timeout: 30_000 }, async () => {
    const cwd = folder(); const terminals = new HerdrTerminals(hc!);
    try {
      // A variable in hc's own environment that no shell sets for itself (bash sets SHELL when it is missing), which
      // Trace's environment for this program leaves out: CLAUDECODE when hc was started inside Claude Code.
      const own = new Set(['SHELL', 'PWD', 'OLDPWD', 'SHLVL', '_', 'PATH', 'HOME', 'USER', 'LOGNAME', 'TERM', 'TMPDIR']);
      const names = await (terminals as unknown as { coreEnvironment(connection: unknown): Promise<string[]>; connect(): Promise<unknown> }).coreEnvironment(await (terminals as unknown as { connect(): Promise<unknown> }).connect());
      const left = names.find((name) => !own.has(name) && !name.startsWith('HC_')); expect(left).toBeDefined();
      const env = Object.fromEntries(Object.entries({ ...process.env, PS1: '$ ' } as Record<string, string>).filter(([name]) => name !== left));
      const pty = await terminals.spawn('/bin/sh', [], { cwd, cols: 80, rows: 24, env }, meta(cwd));
      let seen = ''; pty.onData((text) => { seen += text; }); pty.write(`printenv ${left} || echo "[${left} unset]"\r`);
      expect(await until(() => seen.includes(`[${left} unset]`))).toBe(true); pty.write('exit\r');
    } finally { terminals.close(); remove(cwd); }
  });
  it('gives a program that ends before it is attached its exit, and never fails (PtyManager would run it again)', { timeout: 60_000 }, async () => {
    const cwd = folder(); const terminals = new HerdrTerminals(hc!);
    try {
      for (let i = 0; i < 5; i++) {
        const pty = await terminals.spawn(shell.file, windows ? [...shell.args, '-Command', 'exit 3'] : ['-c', 'exit 3'], { cwd, cols: 80, rows: 24, env: process.env as Record<string, string> }, meta(cwd));
        expect((await new Promise<{ exitCode: number }>((resolve) => pty.onExit(resolve))).exitCode).toBe(3);
      }
    } finally { terminals.close(); remove(cwd); }
  });
  it('makes one connection for starts that come together, keeps its program through a lost line, and keeps its size for a Trace that opens again', { timeout: 60_000 }, async () => {
    const cwd = folder(); const first = new HerdrTerminals(hc!); const options = { cwd, cols: 90, rows: 20, env: { ...process.env, PS1: '$ ' } as Record<string, string> };
    try {
      const [one, two] = await Promise.all([first.spawn(shell.file, shell.args, options, meta(cwd)), first.spawn(shell.file, shell.args, options, meta(cwd))]);
      const lineOf = (pty: unknown) => (pty as { connection: unknown }).connection; expect(lineOf(one)).toBe(lineOf(two));
      let exited = false; one.onExit(() => { exited = true; }); let seen = ''; one.onData((text) => { seen += text; });
      // The line to hc is lost (its hc connect ends); the program goes on, and the terminal is attached again.
      const lost = lineOf(one); (lost as { child: { kill(): void } }).child.kill();
      expect(await until(() => lineOf(one) !== lost && lineOf(two) !== lost, 10_000)).toBe(true);
      one.write('echo back-again\r');
      expect(await until(() => seen.includes('back-again'))).toBe(true); expect(exited).toBe(false);
      // Resized, then taken up by a Trace that opened again: at its new size.
      one.resize(70, 17); await new Promise((resolve) => setTimeout(resolve, 900)); first.close();
      const again = new HerdrTerminals(hc!);
      try {
        const kept = await again.kept(); expect(kept.length).toBeGreaterThanOrEqual(2);
        const sizes = await Promise.all(kept.map(async (id) => { const taken = await again.take(id); const size = taken ? `${taken.pty.cols}x${taken.pty.rows}` : 'none'; taken?.pty.write('exit\r'); return size; }));
        expect(sizes).toContain('70x17'); expect(sizes).toContain('90x20');
      } finally { again.close(); }
    } finally { first.close(); remove(cwd); }
  });
});

