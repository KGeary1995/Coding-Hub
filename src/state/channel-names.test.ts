import { describe, expect, it } from 'vitest';
import { setTerminalTitle, useTitleStore } from './channel-names';

describe('the title a CLI gives its terminal', () => {
  it('loses its spinner but keeps its own first character', () => {
    setTerminalTitle('a', '✳ .env handling'); expect(useTitleStore.getState().titles.a).toBe('.env handling');
    setTerminalTitle('a', '⠐ /review'); expect(useTitleStore.getState().titles.a).toBe('/review');
    setTerminalTitle('a', '· `npm test` fails\x07'); expect(useTitleStore.getState().titles.a).toBe('`npm test` fails');
  });
});
