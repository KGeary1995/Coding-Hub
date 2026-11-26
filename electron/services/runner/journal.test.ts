import { describe, expect, it } from 'vitest';
import { decodeJournal, Journal } from './journal';

describe('a chat journal', () => {
  it('keeps both directions in order, joining a direction\'s run of pieces, and reads back what it encoded', () => {
    const journal = new Journal(); journal.add('in', Buffer.from('ask\n')); journal.add('out', Buffer.from('an')); journal.add('out', Buffer.from('swer\n')); journal.add('in', Buffer.from('é'));
    const read = decodeJournal(journal.encode());
    expect(read.overflowed).toBe(false); expect(read.entries.map((entry) => [entry.dir, entry.data.toString()])).toEqual([['in', 'ask\n'], ['out', 'answer\n'], ['in', 'é']]);
    expect(journal.length).toBe(Buffer.byteLength('ask\nanswer\né'));
  });
  it('drops everything once it would pass its capacity, and says so: a replay needs it from the start', () => {
    const journal = new Journal(10); journal.add('out', Buffer.from('12345')); journal.add('in', Buffer.from('678901'));
    expect(journal.overflowed).toBe(true); journal.add('out', Buffer.from('x'));
    expect(decodeJournal(journal.encode())).toEqual({ overflowed: true, entries: [] });
  });
  it('refuses bytes that are not a journal', () => {
    expect(() => decodeJournal(Buffer.alloc(0))).toThrow(); expect(() => decodeJournal(Buffer.from([0, 1, 0, 0, 0, 9, 65]))).toThrow(); expect(() => decodeJournal(Buffer.from([0, 7, 0, 0, 0, 0]))).toThrow();
  });
});
