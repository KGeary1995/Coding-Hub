import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inputPieces } from './input-pieces';

const sent: string[] = []; let refuse: ((data: string) => string | null) = () => null;
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('./terminals', () => ({ attachCopy: () => {} }));
vi.mock('./workbench', () => ({ workbench: async (request: { action: string; data: string }) => {
  const reason = refuse(request.data); if (reason) throw new Error(reason);
  sent.push(request.data); return null;
} }));
const { LINKED_INPUT_LIMIT, sendLinkedInput } = await import('./linked-terminals');
const { useLinkedStore } = await import('../state/linked-store');

const entry = () => ({ runId: 'r', queue: Promise.resolve() as Promise<unknown>, failures: 0 });

describe('typing into a linked computer\'s channel', () => {
  beforeEach(() => { sent.length = 0; refuse = () => null; useLinkedStore.setState({ addError: '' }); });
  it('sends a paste longer than the host takes in pieces, in order', async () => {
    const paste = 'a'.repeat(6000); const target = entry();
    sendLinkedInput(target, 'pc', 's', paste); await target.queue;
    expect(sent.map((piece) => piece.length)).toEqual([LINKED_INPUT_LIMIT, 6000 - LINKED_INPUT_LIMIT]);
    expect(sent.join('')).toBe(paste);
    expect(useLinkedStore.getState().addError).toBe('');
  });
  it('shows a failure, and does not send what was already waiting behind it', async () => {
    const target = entry(); refuse = (data) => data === 'y' ? 'The computer did not answer.' : null;
    sendLinkedInput(target, 'pc', 's', 'y'); sendLinkedInput(target, 'pc', 's', '\r'); await target.queue;
    expect(sent).toEqual([]);
    expect(useLinkedStore.getState().addError).toContain('The computer did not answer.');
    // What the person types after seeing it goes through again.
    sendLinkedInput(target, 'pc', 's', 'n'); await target.queue;
    expect(sent).toEqual(['n']);
  });
});

describe('input pieces', () => {
  it('never splits a surrogate pair', () => {
    const text = 'a'.repeat(3) + '😀' + 'b';
    const pieces = inputPieces(text, 4);
    expect(pieces).toEqual(['aaa', '😀b']);
    expect(pieces.join('')).toBe(text);
  });
});
