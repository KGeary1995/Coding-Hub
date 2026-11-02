import { describe, expect, it } from 'vitest';
import { macScreenLock, parseConsoleLock } from './screen-lock';

const users = (...sessions: string[]) => `+-o Root  <class IORegistryEntry>\n    {\n      "IOConsoleUsers" = (${sessions.join(',')})\n      "IOConsoleUsersSeed" = <1a010000>\n    }`;
const LOCKED = '{"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="kgeary","CGSSessionScreenLockedTime"=1793403420,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserIDKey"=501}';
const UNLOCKED = '{"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="kgeary","kCGSSessionUserIDKey"=501}';
const AWAY = '{"kCGSSessionOnConsoleKey"=No,"kCGSSessionUserNameKey"="other","CGSSessionScreenIsLocked"=Yes}';

describe('parseConsoleLock', () => {
  it('reads the console session, locked or not', () => {
    expect(parseConsoleLock(users(LOCKED))).toBe(true);
    expect(parseConsoleLock(users(UNLOCKED))).toBe(false);
  });
  it('ignores a switched-away user who is locked', () => {
    expect(parseConsoleLock(users(AWAY, UNLOCKED))).toBe(false);
    expect(parseConsoleLock(users(AWAY, LOCKED))).toBe(true);
  });
  it('cannot say with nobody on the console, or no output', () => {
    expect(parseConsoleLock(users(AWAY))).toBeNull();
    expect(parseConsoleLock('')).toBeNull();
  });
});

describe('macScreenLock', () => {
  it('asks the system once for calls close together, and says null when it cannot', async () => {
    let runs = 0; const locked = macScreenLock((done) => { runs++; done(users(LOCKED)); });
    expect(await locked()).toBe(true); expect(await locked()).toBe(true); expect(runs).toBe(1);
    expect(await macScreenLock((done) => done(null))()).toBeNull();
  });
});
