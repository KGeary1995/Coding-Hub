import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { spawnChatProcess } from './chat-process';

describe('chat process', () => {
  it('reports a CLI that cannot be started without bringing down the app', async () => {
    expect(() => spawnChatProcess('/nonexistent/claude', [], { cwd: os.tmpdir(), env: {} })).toThrow('could not be started');
    // The child's own `error` event follows; unhandled, it would fail this test as an uncaught exception.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
