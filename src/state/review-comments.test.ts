import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types';
import { createSession } from './workspace-store';
import { reviewChannels, reviewMessage } from './review-comments';

const running = (engine: 'claude' | 'codex' | 'shell', cwd: string, extra: Partial<Session> = {}): Session => ({ ...createSession(engine), status: 'running', runId: crypto.randomUUID(), runningCwd: cwd, ...extra });

describe('review comments from Changes', () => {
  it('names each comment\'s file, line and code, with the note under it', () => {
    expect(reviewMessage([
      { id: '1', path: 'src/app.ts', line: 42, removed: false, code: '  const total = 0;', note: 'Start from the saved total.' },
      { id: '2', path: 'README.md', line: 7, removed: true, code: 'Old step', note: 'Keep this step.\nIt is still needed.' },
    ])).toBe([
      'Review comments on your changes (2 comments, from Changes in Trace):', '',
      '1. src/app.ts line 42: `const total = 0;`', '   Start from the saved total.',
      '2. README.md line 7 (removed line): `Old step`', '   Keep this step.', '   It is still needed.',
      '', 'Make these changes, or say why not.',
    ].join('\n'));
  });
  it('offers the running agent channels in the repository or a folder inside it, not shells or other folders', () => {
    const inside = running('claude', 'C:\\Work\\app\\packages\\web'); const root = running('codex', 'c:/work/app/');
    const sessions = [running('claude', 'C:\\Work\\other'), inside, running('shell', 'C:\\Work\\app'), root, { ...createSession('claude'), runningCwd: 'C:\\Work\\app' }];
    expect(reviewChannels(sessions, 'C:\\Work\\app').map(({ session, channel }) => [session.id, channel])).toEqual([[inside.id, 2], [root.id, 4]]);
  });
});
