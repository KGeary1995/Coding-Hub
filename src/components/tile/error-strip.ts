import { SIGN_IN } from '../../../shared/productivity';

/** The setup pages a channel's error strip can lead to, each with its button's words. */
export const SETUP_TARGETS = { projects: 'Choose project', rules: 'Apply shared rules', accounts: 'Account setup' } as const;
export type SetupTarget = keyof typeof SETUP_TARGETS;

/** An exit diagnostic (PtyManager.finish): this sentence, then the CLI's last output, which can hold any words. */
const EXIT = /^CLI exited with code \d+\./;
/** The host's launch errors about the channel's folder (INVALID_DIRECTORY, as it says them now and said them before), and the tile's own when the folder picker fails. */
const FOLDER = /working (?:directory|folder)|\buse projects\b/i;
/** The launch check of shared rules (rules.ts, verifyLaunch): the saved rules are not in this project, or cannot be read there. */
const RULES = /\bshared[ -]rules\b/i;

/**
 * The setup page a channel's error names, or null when it names none (a plain exit code, a model the CLI refuses):
 * the tile then offers only what a failure always has, Retry and Open log. A folder or rules problem is read only from
 * Trace's own launch errors, since a CLI's last output mentions folders and rules for any reason; a sign-in problem
 * also from that output, where the CLI is the one to report it (the sign-in words of recoveryAdvice, without its
 * provider limits, which no setup page lifts). A channel with no folder needs one whatever the error says.
 */
export function setupTarget(error: string, hasFolder: boolean): SetupTarget | null {
  if (!hasFolder) return 'projects';
  const own = !EXIT.test(error);
  if (own && FOLDER.test(error)) return 'projects';
  if (own && RULES.test(error)) return 'rules';
  return SIGN_IN.test(error) ? 'accounts' : null;
}

/**
 * An error as its strip shows it, one line of text after the other. An exit diagnostic carries the console's carriage
 * returns and the blank lines its repaints leave, which stood as empty lines in a strip that shows three. The output is
 * shown whole (up to 2,000 characters, so the strip scrolls): its last lines are not reliably the cause, since on
 * Windows lines the console repaints can follow a CLI's last words (the fixture's "invalid model" is not the last line).
 */
export const errorText = (error: string) => error.split(/[\r\n]+/).map((line) => line.trimEnd()).filter(Boolean).join('\n');
