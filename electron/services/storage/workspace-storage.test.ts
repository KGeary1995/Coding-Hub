import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStorage } from './workspace-storage';
import type { SavedWorkspace } from '../../../shared/types';

const directories: string[] = [];
const databases: WorkspaceStorage[] = [];
function open(limits = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hub-storage-'));
  directories.push(root);
  const storage = new WorkspaceStorage(root, undefined, limits);
  databases.push(storage);
  return { root, storage };
}
function workspace(): SavedWorkspace {
  return {
    version: 1, rootDirectory: '/projects/root', layoutMode: 'columns', focusedSessionId: null,
    sessions: [
      { id: 'claude', title: 'Claude Code', config: { engine: 'claude', model: 'claude-sonnet-4-6', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: 8192, maxSessionTokens: null } }, binding: { mode: 'workspace' }, createdAt: new Date().toISOString() },
      { id: 'codex', title: 'Codex', config: { engine: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'high' }, binding: { mode: 'independent', cwd: '/projects/second' }, createdAt: new Date().toISOString() },
    ],
    tiles: ['claude', 'codex'].map((sessionId, index) => ({ sessionId, x: index * 6, y: 0, w: 6, h: 14, minW: 3, minH: 10 })),
  };
}
function run(storage: WorkspaceStorage) {
  const reference = { sessionId: 'codex', runId: randomUUID(), pid: 12345, engine: 'codex' as const, cwd: '/projects/second' };
  storage.beginRun(reference, { engine: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'high' });
  return reference.runId;
}
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  directories.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('local workspace storage', () => {
  it('restores exact settings and resized layout from a reopened SQLite database', () => {
    const { root, storage } = open();
    expect(storage.load()).toBeNull();
    const snapshot = workspace();
    snapshot.focusedSessionId = 'codex';
    storage.save(snapshot); storage.close();
    const reopened = new WorkspaceStorage(root); databases.push(reopened);
    expect(reopened.load()).toEqual(snapshot);
    expect(readFileSync(path.join(root, 'storage.db')).subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('rejects live PIDs, duplicate/missing tiles, overlaps and traversal log references without replacing data', () => {
    const { storage } = open(); const snapshot = workspace(); storage.save(snapshot);
    expect(() => storage.save({ ...snapshot, sessions: snapshot.sessions.map((item) => ({ ...item, pid: 42 })) })).toThrow();
    expect(() => storage.save({ ...snapshot, tiles: [snapshot.tiles[0], snapshot.tiles[0]] })).toThrow();
    expect(() => storage.save({ ...snapshot, tiles: snapshot.tiles.map((tile) => ({ ...tile, x: 0 })) })).toThrow();
    expect(() => storage.readLog({ runId: '../../other' })).toThrow();
    expect(() => storage.readLog({ runId: randomUUID(), path: '/etc/passwd' })).toThrow();
    expect(storage.load()).toEqual(snapshot);
  });

  it('preserves unreadable settings and rejects future database versions', () => {
    const { root, storage } = open(); storage.close();
    const db = new DatabaseSync(path.join(root, 'storage.db'));
    db.prepare('INSERT INTO workspace(id,snapshot) VALUES(1,?)').run('{bad json'); db.close();
    const reopened = new WorkspaceStorage(root); databases.push(reopened);
    expect(() => reopened.load()).toThrow('Existing data was preserved'); reopened.close();
    const check = new DatabaseSync(path.join(root, 'storage.db'));
    expect(check.prepare('SELECT snapshot FROM workspace').get()?.snapshot).toBe('{bad json');
    check.exec('PRAGMA user_version=99'); check.close();
    expect(() => new WorkspaceStorage(root)).toThrow('newer version');
  });

  it('flushes ANSI output and split emoji on exit, and distinguishes interrupted runs after restart', () => {
    const { root, storage } = open(); const ended = run(storage);
    storage.append(ended, '\x1b[32mREADY\x1b[0m\n\ud83d');
    storage.history(); // Force a flush at a chunk boundary.
    storage.append(ended, '\ude80 final output'); storage.endRun(ended, 7);
    expect(storage.readLog({ runId: ended }).text).toBe('READY\n🚀 final output');
    const interrupted = run(storage); storage.append(interrupted, 'unfinished run'); storage.close();
    const reopened = new WorkspaceStorage(root); databases.push(reopened);
    const history = reopened.history();
    expect(history.find((item) => item.runId === ended)).toMatchObject({ status: 'completed', exitCode: 7, config: { reasoningEffort: 'high' } });
    expect(history.find((item) => item.runId === interrupted)).toMatchObject({ status: 'interrupted', exitCode: null });
    expect(reopened.readLog({ runId: interrupted }).text).toBe('unfinished run');
    expect(history.every((item) => !('pid' in item))).toBe(true);
  });

  it('bounds UTF-8 logs without cutting a character and preserves active runs during retention', () => {
    const { storage } = open({ maxLogBytes: 8, maxCompletedRuns: 1 });
    const active = run(storage); storage.append(active, 'active');
    const first = run(storage); storage.append(first, 'abcdef🚀more'); storage.endRun(first, 0);
    expect(storage.readLog({ runId: first })).toMatchObject({ text: 'abcdef', logTruncated: true });
    const second = run(storage); storage.append(second, 'newest'); storage.endRun(second, 0);
    expect(storage.history().map((item) => item.runId).sort()).toEqual([active, second].sort());
    expect(() => storage.readLog({ runId: first })).toThrow('no longer available');
    expect(storage.readLog({ runId: active }).text).toBe('active');
  });

  it('returns only a bounded tail for a large log', () => {
    const { storage } = open(); const id = run(storage);
    storage.append(id, 'x'.repeat(1100000) + '\nFINAL'); storage.endRun(id, 0);
    const log = storage.readLog({ runId: id });
    expect(log.tailOnly).toBe(true);
    expect(log.text.endsWith('\nFINAL')).toBe(true);
    expect(Buffer.byteLength(log.text)).toBeLessThanOrEqual(1024 * 1024);
  });
});
