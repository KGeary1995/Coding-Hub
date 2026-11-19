/** Where this phone remembers "Desktop size" (`'desktop'`), next to its text size; "Fit to phone" clears it. */
export const FIT_KEY = 'trace-remote-fit';

/**
 * Whether a terminal channel opened on this phone is taken at the phone's size. Opening it is the act of the person
 * holding the phone, so it is, at once and even while the computer is in use, as "Fit to phone" does; unless they
 * chose "Desktop size" on this phone, which the next channel keeps until they press "Fit to phone".
 */
export const fitsOnOpen = (chosen: string | null) => chosen !== 'desktop';

/**
 * Whether the phone shows the channel at its own size, with the text at the chosen size and "Desktop size" on the
 * button: once the computer has drawn it there, and while the phone's own request is on its way, so an opened channel
 * is never first drawn at the desktop's width with its text shrunk to a few pixels.
 */
export const atPhoneSize = (granted: boolean, holding: boolean) => granted || holding;

/**
 * Whether a channel redrawn at a size that is not one the phone asked for (`mine`) means the desktop took it back (the
 * person typed there), so the phone stops asking until it is used. Only a size the phone `had` been given counts: a
 * channel restarted on the computer starts at the desktop's size, which takes nothing from the phone.
 */
export const takenBack = (had: boolean, holding: boolean, asked: boolean, mine: boolean) => had && holding && asked && !mine;
