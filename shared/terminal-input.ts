/**
 * Replies a terminal sends on its own when the CLI asks it something: cursor position and device attributes
 * (`ESC[6n`, `ESC[c`), mode and window reports, and OSC colour or DCS settings answers. A key press never looks like these.
 */
const TERMINAL_REPLIES = /\x1b\[\??[\d;]*R|\x1b\[[?>=][\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\[\d+(;\d+)*t|\x1b\[[\d;]*n|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;
/** The data without terminal replies: what a person actually typed. */
export const withoutTerminalReplies = (data: string) => data.replace(TERMINAL_REPLIES, '');

/** Focus and mouse reports and terminal replies are sent without the person doing anything; they do not answer a prompt. */
export function isPersonInput(data: string) {
  return data.replace(/\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[mM]|\x1b\[M[\s\S]{3}/g, '').replace(TERMINAL_REPLIES, '').length > 0;
}
