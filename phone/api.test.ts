import { describe, expect, it } from 'vitest';
import { connectionProblem } from './api';

describe('why the phone app cannot connect', () => {
  const host = 'macbook.tail0000.ts.net';
  it('names the computer and its address, and tells a closed Trace from a computer that cannot be reached', () => {
    expect(connectionProblem(Object.assign(new Error('Bad Gateway'), { status: 502 }), 'MacBook', host)).toBe('MacBook (macbook.tail0000.ts.net) is on, but Trace is not open there. Open Trace on that computer, or add this app again from the computer you want.');
    expect(connectionProblem(new TypeError('Failed to fetch'), 'MacBook', host)).toBe('MacBook (macbook.tail0000.ts.net) can’t be reached. Check that it is on, and that Tailscale is connected on this phone.');
    // The six-second connecting limit ends as an abort, with no status either.
    expect(connectionProblem(new DOMException('Aborted', 'AbortError'), null, host)).toBe('macbook.tail0000.ts.net can’t be reached. Check that it is on, and that Tailscale is connected on this phone.');
    expect(connectionProblem(Object.assign(new Error('Unknown host.'), { status: 421 }), null, host)).toBe('macbook.tail0000.ts.net did not accept this phone: Unknown host.');
  });
});
