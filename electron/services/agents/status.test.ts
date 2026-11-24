import { afterEach, describe, expect, it } from 'vitest';
import { CustomStatusReader, type CustomStatusChange } from './status';

const readers: CustomStatusReader[] = [];
afterEach(() => { for (const reader of readers.splice(0)) reader.dispose(); });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function reader(status: ConstructorParameters<typeof CustomStatusReader>[0], quietMs?: number) {
  const changes: CustomStatusChange[] = [];
  const made = new CustomStatusReader(status, 80, 24, (change) => changes.push(change), { checkMs: 20, ...(quietMs ? { quietMs } : {}) }); readers.push(made);
  return { changes, made };
}
/** The person sends a request, and the agent answers after the echo. */
async function turn(made: CustomStatusReader, output: string) { made.input('do it\r'); made.push('do it\r\n'); await sleep(300); made.push(output); await sleep(120); }

describe('custom agent status', () => {
  it('a waiting pattern on the screen is Needs you, with its line as the message; its going away is answered', async () => {
    const { changes, made } = reader({ waiting: ['\\(Y\\)es/\\(N\\)o'] });
    made.push('Working…\r\nEdit main.py? (Y)es/(N)o '); await sleep(120);
    expect(changes).toEqual([{ kind: 'waiting', message: 'Edit main.py? (Y)es/(N)o' }]);
    made.push('\x1b[2J\x1b[HDone editing\r\n'); await sleep(120);
    expect(changes.at(-1)).toEqual({ kind: 'resolved' });
  });
  it('the turn-end pattern on the prompt line ends a turn, but not the start screen before any request', async () => {
    const { changes, made } = reader({ turnEnd: ['^> $'] });
    made.push('Welcome to the agent\r\n> '); await sleep(120); expect(changes).toEqual([]);
    await turn(made, 'Fixed the test.\r\n> '); expect(changes).toEqual([{ kind: 'turn-ended' }]);
    // The prompt still there, with nothing new asked: no second end.
    made.push(''); await sleep(120); expect(changes).toHaveLength(1);
  });
  it('quiet time after output ends a turn; while it waits for the person it does not', async () => {
    const { changes, made } = reader({ quietSeconds: 2, waiting: ['Allow\\?'] }, 200);
    await turn(made, 'thinking…'); await sleep(350); expect(changes).toEqual([{ kind: 'turn-ended' }]);
    await turn(made, 'Allow?'); await sleep(350); expect(changes.slice(1)).toEqual([{ kind: 'waiting', message: 'Allow?' }]);
  });
  it('OSC notifications end a turn, or mean waiting when their text matches a waiting pattern', async () => {
    const { changes, made } = reader({ osc: true, waiting: ['approve'] });
    made.push('\x1b]9;Please approve the edit\x07'); expect(changes).toEqual([{ kind: 'waiting', message: 'Please approve the edit' }]);
    made.input('y\r'); made.push('\x1b]777;notify;Agent;Turn complete\x07'); expect(changes.at(-1)).toEqual({ kind: 'turn-ended' });
    made.input('next\r'); made.push('\x1b]99;i=1;Finished\x1b\\'); expect(changes.at(-1)).toEqual({ kind: 'turn-ended' });
    // A progress bar (OSC 9;4) is not a notification.
    made.input('more\r'); made.push('\x1b]9;4;1;50\x07'); expect(changes).toHaveLength(3);
  });
  it('a run started with its first request as arguments has a turn under way without an Enter', async () => {
    const { changes, made } = reader({ turnEnd: ['^> $'] });
    made.begin(); await sleep(300); made.push('Working on it…\r\nDone.\r\n> '); await sleep(120);
    expect(changes).toEqual([{ kind: 'turn-ended' }]);
  });
  it('without any signal named it reports nothing', async () => {
    const { changes, made } = reader(undefined);
    await turn(made, 'answer\r\n> '); await sleep(100); expect(changes).toEqual([]);
  });
});
