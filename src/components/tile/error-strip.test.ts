import { describe, expect, it } from 'vitest';
import { errorLines, errorText, setupTarget, SETUP_TARGETS } from './error-strip';

describe('where a channel’s error strip leads', () => {
  it('is Projects for a missing folder, as the host says it now and said it before', () => {
    expect(setupTarget('The working folder does not exist or is not accessible.', true)).toBe('projects');
    expect(setupTarget('The working directory does not exist or is not accessible.', true)).toBe('projects');
    expect(setupTarget('Choose an absolute local working folder.', true)).toBe('projects');
    expect(setupTarget('Folder picker unavailable. Use Projects to enter a path.', true)).toBe('projects');
    expect(SETUP_TARGETS.projects).toBe('Choose project');
  });
  it('is Projects for a channel with no folder, whatever the error says', () => {
    expect(setupTarget('Choose a workspace root or an independent repository folder first.', false)).toBe('projects');
    expect(setupTarget('CLI exited with code 1.', false)).toBe('projects');
  });
  it('is Shared rules for the launch check of the rules', () => {
    expect(setupTarget('Apply the current Shared rules to this project before starting a channel. Both engines must receive the same saved rules.', true)).toBe('rules');
    expect(setupTarget('Shared rules were cleared, but this project still has the old rules. Apply the change in Shared rules before starting a channel.', true)).toBe('rules');
    expect(setupTarget('An instruction file contains incomplete or duplicate shared-rules markers. Repair that section before applying rules.', true)).toBe('rules');
    expect(SETUP_TARGETS.rules).toBe('Apply shared rules');
  });
  it('is Accounts for a sign-in problem, in the CLI’s words or the host’s', () => {
    for (const tail of ['Not logged in · Please run /login', 'Error: 401 Unauthorized', 'OAuth token has expired', 'Please sign in again.']) expect(setupTarget(`CLI exited with code 1.\n${tail}`, true), tail).toBe('accounts');
    expect(setupTarget('Finish or cancel this profile’s login before starting a channel.', true)).toBe('accounts');
    expect(SETUP_TARGETS.accounts).toBe('Account setup');
  });
  it('is nowhere for a plain exit code, or for output that names no setup page', () => {
    expect(setupTarget('CLI exited with code 1. No terminal error was reported. Try the CLI directly in PowerShell from this project folder.', true)).toBeNull();
    for (const tail of ['READY CWD:C:\\Users\\kg\\tour-project\r\nError: fixture invalid model', 'The author field is missing in package.json', 'API Error: 429 rate limit', 'error: unknown option --foo'])
      expect(setupTarget(`CLI exited with code 1.\n${tail}`, true), tail).toBeNull();
    expect(setupTarget('The channel could not be started.', true)).toBeNull();
    expect(setupTarget('This Claude profile is unavailable. Select another profile in the channel’s settings.', true)).toBeNull();
    expect(setupTarget('Model and reasoning overrides cleared. The next launch starts a fresh conversation using local CLI defaults; the old conversation remains in native history.', true)).toBeNull();
  });
  it('reads a folder or rules problem only from Trace’s own errors, not from what the CLI printed last', () => {
    expect(setupTarget('CLI exited with code 1.\nfatal: cannot change to the working directory', true)).toBeNull();
    expect(setupTarget('CLI exited with code 1.\nI have read the shared rules and will follow them.', true)).toBeNull();
  });
});

describe('an error as its strip shows it', () => {
  it('drops the blank lines and carriage returns of an exit diagnostic', () => {
    expect(errorText('CLI exited with code 1.\nREADY\r\nSIZE:85x30\r\n\n\r\n\r\nError: fixture invalid model\r\n\r\n')).toBe('CLI exited with code 1.\nREADY\nSIZE:85x30\nError: fixture invalid model');
    expect(errorText('progress 10%\rprogress 100%   \n   \ndone')).toBe('progress 10%\nprogress 100%\ndone');
  });
  it('keeps every line of the output: the cause is not reliably the last one (the Windows console repaints older lines after it)', () => {
    expect(errorText('CLI exited with code 1.\nREADY\r\nError: fixture invalid model\r\nSIZE:132x7\r\nSIZE:63x11')).toContain('fixture invalid model');
  });
  it('leaves a one-line error as it is', () => {
    expect(errorText('The working folder does not exist or is not accessible.')).toBe('The working folder does not exist or is not accessible.');
  });
});

describe('the lines a closed error strip shows', () => {
  /** The fixture CLI's failure as a probe of the dev window read it on Windows: the cause mid-output, repainted lines after it. */
  const start = 'READY CWD:C:\\Users\\kg\\tour-project\r\nMODEL_OVERRIDE:CLI_DEFAULT\r\nSIZE:85x13\r\n';
  const fixture = `CLI exited with code 1.\n${start}\n${start}${'\r\n'.repeat(9)}\nECHO:Add a check for an empty name to greet()\r\nECHO:Then run the tests\r\n\n${'\r\n'.repeat(5)}Error: fixture invalid model${'\r\n'.repeat(7)}\n\n${start}ECHO:Add a check for an empty name to greet()\r\nECHO:Then run the tests`;
  it('keeps the fixture’s cause, which is neither among the first lines nor the last (the smoke tests look for it)', () => {
    expect(errorLines(fixture)).toEqual({ lines: ['CLI exited with code 1.', 'Error: fixture invalid model'], more: true });
  });
  it('shows the last lines when no line reads as an error', () => {
    expect(errorLines('CLI exited with code 2.\nREADY\nMODEL_OVERRIDE:CLI_DEFAULT\nSIZE:85x30\nECHO:done')).toEqual({ lines: ['CLI exited with code 2.', 'SIZE:85x30', 'ECHO:done'], more: true });
  });
  it('shows a Trace launch error of one sentence whole, with nothing left out', () => {
    for (const error of ['The working folder does not exist or is not accessible.', 'CLI exited with code 1. No terminal error was reported. Try the CLI directly in PowerShell from this project folder.'])
      expect(errorLines(error)).toEqual({ lines: [error], more: false });
  });
  it('leaves a long single line whole (the strip cuts it to its width, and its title keeps it)', () => {
    const long = 'Error: ' + 'x'.repeat(1990);
    expect(errorLines(`CLI exited with code 1.\n${long}`)).toEqual({ lines: ['CLI exited with code 1.', long], more: false });
  });
  it('keeps the two most recent of more error lines than fit, in the order printed', () => {
    expect(errorLines('CLI exited with code 1.\nfatal: not a git repository\nnpm ERR! code ENOENT\nworking…\nTypeError: x is undefined\nE: Unable to locate package\nE:\\project> ').lines).toEqual(['CLI exited with code 1.', 'TypeError: x is undefined', 'E: Unable to locate package']);
  });
  it('reads a sign-in problem as a cause, as setupTarget does', () => {
    expect(errorLines('CLI exited with code 1.\nWelcome\nNot logged in · Please run /login\nSIZE:80x24\nSIZE:81x24').lines).toEqual(['CLI exited with code 1.', 'Not logged in · Please run /login']);
  });
  it('reads Windows line endings and the console’s blank lines as one line break', () => {
    expect(errorLines('CLI exited with code 1.\r\n\r\nREADY\r\n\r\n\r\nError: invalid model\r\n\r\nSIZE:85x13\r\n')).toEqual({ lines: ['CLI exited with code 1.', 'Error: invalid model'], more: true });
    expect(errorLines('CLI exited with code 1.\r\nError: invalid model\r\n')).toEqual({ lines: ['CLI exited with code 1.', 'Error: invalid model'], more: false });
  });
});
