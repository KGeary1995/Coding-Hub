import { describe, expect, it } from 'vitest';
import { lastSegment, remoteUsage } from './phone-data';

describe('phone data', () => {
  it('names a folder by its last part only, on Windows and elsewhere', () => {
    expect(lastSegment('C:\\Users\\me\\work\\app')).toBe('app'); expect(lastSegment('C:\\Users\\me\\work\\app\\')).toBe('app');
    expect(lastSegment('/home/me/app/')).toBe('app'); expect(lastSegment('\\\\server\\share\\app')).toBe('app');
    expect(lastSegment(null)).toBe(''); expect(lastSegment('')).toBe('');
  });
  it('gives no budget unless one is set, and the default warning share otherwise', () => {
    const today = { day: '2026-11-07', claude: 1, codex: 2, cost: null, complete: false };
    expect(remoteUsage(today, [], null).budget).toBeNull();
    expect(remoteUsage(today, [], { dailyTokens: null, dailyCost: null }).budget).toBeNull();
    expect(remoteUsage(today, [], { dailyCost: 5 }).budget).toEqual({ tokens: null, dollars: 5, warnAt: 0.8 });
  });
});
