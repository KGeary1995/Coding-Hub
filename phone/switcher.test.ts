import { describe, expect, it } from 'vitest';
import type { RemoteChannel } from '../shared/remote';
import { switcherOrder } from './switcher';

const channel = (number: number, running: boolean, attention: string | null = null) => ({ sessionId: `s${number}`, channel: number, title: `T${number}`, engine: 'claude', runId: null, running, attention, cols: null, rows: null }) as RemoteChannel;

describe('the phone switcher', () => {
  it('lists the channels that need you first, then running ones, then the rest', () => {
    expect(switcherOrder([channel(1, false), channel(2, true), channel(3, true, 'Allow?'), channel(4, true), channel(5, false, 'Retry?')]).map((item) => item.channel)).toEqual([3, 5, 2, 4, 1]);
  });
});
