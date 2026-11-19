import { useEffect, useRef, useState } from 'react';
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
 * An error as its strip shows it opened, one line of text after the other. An exit diagnostic carries the console's
 * carriage returns and the blank lines its repaints leave, which stood as empty lines in the strip.
 */
export const errorText = (error: string) => error.split(/[\r\n]+/).map((line) => line.trimEnd()).filter(Boolean).join('\n');

/**
 * An output line that reads as a failure's cause: error words in the forms CLIs print them ("Error:", "TypeError",
 * "npm ERR!", "fatal:", "E: …", "✗ …"), and the sign-in words setupTarget reads. A drive letter ("E:\") is not "E:".
 */
const CAUSE = /error|\berr!|\bfatal\b|\bfail(?:ed|ure|s)\b|\binvalid\b|\bdenied\b|\bnot found\b|\bno such\b|\bcannot\b|\bcan['’]t\b|\bcould not\b|\bunable to\b|\bforbidden\b|\brefused\b|\bexception\b|\bpanic\b|\btraceback\b|^\s*(?:E:(?![\\/])|[✗×✖])/i;

/**
 * What a closed strip shows, three lines at most: the error's first line ("CLI exited with code N." for an exit
 * diagnostic), then the two most recent output lines that read as a cause, in the order printed, or the last two lines
 * when none does. The cause is not reliably last (on Windows the console repaints older lines after a CLI's last words,
 * and the fixture's "invalid model" sits mid-output). `more` says lines were left out, for the strip's Show all.
 */
export function errorLines(error: string): { lines: string[]; more: boolean } {
  const all = errorText(error).split('\n');
  if (all.length <= 3) return { lines: all, more: false };
  const output = all.slice(1); const causes = output.filter((line) => CAUSE.test(line) || SIGN_IN.test(line));
  return { lines: [all[0], ...(causes.length ? causes : output).slice(-2)], more: true };
}

/**
 * A failed channel's strip: whether it is open, and whether its closed lines are cut (a line wider than the tile, or a
 * one-line error longer than three wrapped lines), measured as the tile resizes. A new error closes it again.
 */
export function useErrorStrip(error: string | null | undefined) {
  const [open, setOpen] = useState(false); const [cut, setCut] = useState(false);
  const lines = useRef<HTMLSpanElement>(null);
  useEffect(() => setOpen(false), [error]);
  useEffect(() => {
    const box = lines.current; if (!box || open) return;
    const measure = () => setCut([...box.children].some((line) => line.scrollWidth > line.clientWidth + 1 || line.scrollHeight > line.clientHeight + 1));
    const observer = new ResizeObserver(measure); observer.observe(box); measure();
    return () => observer.disconnect();
  }, [error, open]);
  return { open, setOpen, cut, lines };
}
