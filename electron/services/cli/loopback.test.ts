import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listenLoopback, savedToken } from './loopback';

const servers: http.Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });
const made = () => { const server = http.createServer(); servers.push(server); return server; };

describe('listenLoopback', () => {
  it('comes back on the port it had when that port is free, and on another when it is taken', async () => {
    const first = made(); const port = await listenLoopback(first); await new Promise((resolve) => first.close(resolve));
    expect(await listenLoopback(made(), port)).toBe(port);
    const other = await listenLoopback(made(), port); expect(other).not.toBe(port); expect(other).toBeGreaterThan(0);
  });
  it('takes back only a token of the right shape', () => {
    expect(savedToken('ab'.repeat(32))?.length).toBe(32); expect(savedToken('xyz')).toBeNull(); expect(savedToken(42)).toBeNull();
  });
});
