/** A Mac (from the window's user agent): keys and install commands differ there. */
export const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
/** The key Trace's shortcuts take with a letter: Cmd on a Mac, Ctrl elsewhere (every handler accepts either). */
export const MOD_KEY = MAC ? 'Cmd' : 'Ctrl';
/** An example folder in the form this computer writes paths, for a field's placeholder. */
export const examplePath = (...parts: string[]) => MAC ? ['/Users/you', ...parts].join('/') : ['C:\\Users\\you', ...parts].join('\\');
