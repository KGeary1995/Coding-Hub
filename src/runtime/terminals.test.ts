import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../shared/hub';
import type { Session } from '../../shared/types';

/** A page element that keeps its listeners, so tests can send it events. */
class FakeElement {
  listeners: Record<string, ((event: unknown) => void)[]> = {}; className = '';
  addEventListener(type: string, listener: (event: unknown) => void) { (this.listeners[type] ??= []).push(listener); }
  appendChild() {} remove() {}
  emit(type: string, event: unknown = {}) { for (const listener of this.listeners[type] ?? []) listener(event); }
}
const addons: FakeWebgl[] = [];
class FakeWebgl { disposed = false; loss: (() => void) | null = null; constructor() { addons.push(this); } onContextLoss(listener: () => void) { this.loss = listener; } dispose() { this.disposed = true; } }
let osc: ((data: string) => boolean) | null = null;
class FakeTerminal {
  options: Record<string, unknown> = {}; cols = 80; rows = 24; modes = { bracketedPasteMode: false }; unicode = { activeVersion: '6' }; parser = { registerOscHandler: (_code: number, handler: (data: string) => boolean) => { osc = handler; } };
  loadAddon(addon: unknown) { if (addon instanceof FakeWebgl && failLoads) throw new Error('no WebGL'); }
  open() {} onData() {} onTitleChange() {} onResize() {} attachCustomKeyEventHandler() {} writeln() {} write() {} reset() {} focus() {} dispose() {}
  hasSelection() { return false; } clearSelection() {}
}
let failLoads = false;
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebgl }));
const copied: string[] = [];
vi.stubGlobal('document', { createElement: () => new FakeElement() });
const written: { data: string; at: number }[] = [];
vi.stubGlobal('window', { codingHub: { copyText: async (text: string) => { copied.push(text); }, writeSession: async (input: { data: string }) => { written.push({ data: input.data, at: Date.now() }); return { ok: true, value: null }; }, resizeSession: async () => ({ ok: true, value: null }) } });

const { getTerminal, onWebGLContextLost, releaseRemovedTerminals, routeTerminalEvent, submitTerminal } = await import('./terminals');
const { useHubStore } = await import('../state/hub-store');
const { createSession, useWorkspaceStore } = await import('../state/workspace-store');

const webgl = (on: boolean) => useHubStore.setState({ preferences: { ...DEFAULT_PREFERENCES, terminalWebGL: on } });
const terminalFor = (session: Session) => { useWorkspaceStore.setState((state) => ({ sessions: [...state.sessions, session] })); return getTerminal(session) as unknown as { element: FakeElement; webgl?: FakeWebgl }; };

describe('WebGL terminals', () => {
  // Each test an hour after the last, so losses counted in one do not count in the next.
  let clock = Date.now();
  beforeEach(() => { vi.useFakeTimers({ now: clock += 60 * 60 * 1000 }); addons.length = 0; failLoads = false; webgl(true); });
  afterEach(() => { releaseRemovedTerminals([]); onWebGLContextLost(null); vi.useRealTimers(); });
  it('go back to the DOM renderer at once when the graphics context is lost, and use WebGL again a little later', async () => {
    let reported = 0; onWebGLContextLost(() => { reported++; });
    const entry = terminalFor(createSession('claude')); const first = entry.webgl!; expect(first).toBeInstanceOf(FakeWebgl);
    entry.element.emit('webglcontextlost'); await vi.advanceTimersByTimeAsync(0);
    expect(first.disposed).toBe(true); expect(entry.webgl).toBeUndefined(); expect(reported).toBe(1);
    // The addon's own notice 3 s later changes nothing more.
    first.loss?.(); expect(reported).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); expect(entry.webgl).toBeInstanceOf(FakeWebgl); expect(entry.webgl).not.toBe(first);
  });
  it('stay on the DOM renderer after three losses within ten minutes', async () => {
    const entry = terminalFor(createSession('codex'));
    for (let loss = 0; loss < 3; loss++) { entry.webgl!.loss!(); await vi.advanceTimersByTimeAsync(5000); }
    expect(entry.webgl).toBeUndefined(); expect(terminalFor(createSession('claude')).webgl).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); expect(terminalFor(createSession('claude')).webgl).toBeInstanceOf(FakeWebgl);
  });
  it('count one GPU reset that loses every terminal\'s context as one loss', async () => {
    let reported = 0; onWebGLContextLost(() => { reported++; });
    const entries = [terminalFor(createSession('claude')), terminalFor(createSession('codex')), terminalFor(createSession('claude'))];
    const before = entries.map((entry) => entry.webgl!);
    for (const entry of entries) entry.element.emit('webglcontextlost'); await vi.advanceTimersByTimeAsync(0);
    expect(entries.every((entry) => entry.webgl === undefined)).toBe(true); expect(reported).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    entries.forEach((entry, index) => { expect(entry.webgl).toBeInstanceOf(FakeWebgl); expect(entry.webgl).not.toBe(before[index]); });
  });
  it('follow the setting when it changes, also for terminals made before the settings loaded', () => {
    webgl(false); const entry = terminalFor(createSession('claude')); expect(entry.webgl).toBeUndefined();
    webgl(true); expect(entry.webgl).toBeInstanceOf(FakeWebgl);
    const addon = entry.webgl!; webgl(false); expect(addon.disposed).toBe(true); expect(entry.webgl).toBeUndefined();
  });
  it('keep drawing without WebGL when it cannot be loaded', () => {
    failLoads = true; const entry = terminalFor(createSession('claude')); expect(entry.webgl).toBeUndefined(); expect(addons[0].disposed).toBe(true);
  });
});

describe('a CLI setting the clipboard (OSC 52)', () => {
  afterEach(() => { releaseRemovedTerminals([]); copied.length = 0; });
  const request = btoa('copied text');
  it('is honoured just after a key press in Claude Code and Codex channels, never in a plain terminal', () => {
    const agent = terminalFor(createSession('claude')); agent.element.emit('keydown'); osc!(`c;${request}`); expect(copied).toEqual(['copied text']);
    const shell = terminalFor(createSession('shell')); shell.element.emit('keydown'); osc!(`c;${request}`); expect(copied).toEqual(['copied text']);
  });
});

describe('a request typed into an agent’s terminal', () => {
  afterEach(() => { releaseRemovedTerminals([]); written.length = 0; });
  it('is typed, then sent with an Enter of its own a moment later (a burst with its Enter was taken as a paste)', async () => {
    const session = { ...createSession('claude'), status: 'running' as const, runId: 'r1' }; terminalFor(session);
    routeTerminalEvent({ type: 'started', sessionId: session.id, runId: 'r1', engine: 'claude', pid: 1, cwd: '/p' } as never);
    expect(await submitTerminal(session.id, 'Fix sum.js')).toBe(true);
    expect(written.map((item) => item.data)).toEqual(['Fix sum.js', '\r']);
    expect(written[1].at - written[0].at).toBeGreaterThanOrEqual(150);
  });
  it('goes in as a bracketed paste when the program asked for one, so a long request is still sent by its Enter', async () => {
    const session = { ...createSession('codex'), status: 'running' as const, runId: 'r2' }; const { terminal } = terminalFor(session) as unknown as { terminal: { modes: { bracketedPasteMode: boolean } } };
    routeTerminalEvent({ type: 'started', sessionId: session.id, runId: 'r2', engine: 'codex', pid: 1, cwd: '/p' } as never);
    terminal.modes.bracketedPasteMode = true;
    // A paste end inside the text cannot end the paste early and type the rest as keys.
    expect(await submitTerminal(session.id, 'Review this.\nLine two \x1b[201~ echo typed')).toBe(true);
    expect(written.map((item) => item.data)).toEqual(['\x1b[200~Review this.\nLine two  echo typed\x1b[201~', '\r']);
  });
  it('typed as keys, waits longer before a long request\'s Enter (a 4,000-character one stayed in Codex\'s prompt after 200 ms)', async () => {
    const session = { ...createSession('codex'), status: 'running' as const, runId: 'r3' }; terminalFor(session);
    routeTerminalEvent({ type: 'started', sessionId: session.id, runId: 'r3', engine: 'codex', pid: 1, cwd: '/p' } as never);
    expect(await submitTerminal(session.id, 'x'.repeat(4000))).toBe(true);
    expect(written[1].at - written[0].at).toBeGreaterThanOrEqual(1100);
  });
});
