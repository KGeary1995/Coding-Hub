/** Where phones before 1.36.0 remembered "Desktop size"; cleared when the app starts (the choice is gone). */
export const FIT_KEY = 'trace-remote-fit';

/**
 * Whether the phone shows the channel at its own size, with no line saying the computer leads: once the computer has drawn it there, and while the phone's own request is on its way, so an opened channel
 * is never first drawn at the desktop's width with its text shrunk to a few pixels.
 */
export const atPhoneSize = (granted: boolean, holding: boolean) => granted || holding;

/**
 * Whether a channel redrawn at a size that is not one the phone asked for (`mine`) means the desktop took it back (the
 * person typed there), so the phone stops asking until it is used. Only a size the phone `had` been given counts: a
 * channel restarted on the computer starts at the desktop's size, which takes nothing from the phone.
 */
export const takenBack = (had: boolean, holding: boolean, asked: boolean, mine: boolean) => had && holding && asked && !mine;
