/** A Mac (from the window's user agent): keys and install commands differ there. */
export const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
