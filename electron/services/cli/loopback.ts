import type http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Listens on loopback, on `preferred` when it is free and on any port otherwise; resolves with the port. Agents the
 * background runner kept running while Trace was closed still call the address they were started with, so Trace's hook
 * and channel-tool servers come back on the port they had (docs/background-runner.md, step 3).
 */
export function listenLoopback(server: http.Server, preferred?: number | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const listen = (port: number) => server.listen(port, '127.0.0.1');
    const failed = (error: NodeJS.ErrnoException) => { if (preferred && error.code === 'EADDRINUSE') { preferred = null; listen(0); } else reject(error); };
    server.on('error', failed);
    server.once('listening', () => { server.off('error', failed); resolve((server.address() as AddressInfo).port); });
    listen(preferred && Number.isInteger(preferred) && preferred > 1023 && preferred < 65536 ? preferred : 0);
  });
}

/** A run's token given back after a restart: 32 bytes as hex, or nothing. */
export function savedToken(hex: unknown): Buffer | null { return typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null; }
