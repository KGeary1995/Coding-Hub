import { describe, expect, it } from 'vitest';
import { errorText, setupTarget, SETUP_TARGETS } from './error-strip';

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
