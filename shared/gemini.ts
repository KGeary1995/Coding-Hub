/**
 * The only model a Gemini channel runs: the highest model on the person's subscription (their rule, 2026-11-11: highest
 * model only, never a fallback). Trace always passes it with --model and refuses to start when agy --help does not list --model.
 * When Google ships a newer top model this must be changed here by hand.
 */
export const GEMINI_MODEL = 'gemini-4-argon-high';
/** The program Trace looks for on PATH. */
export const GEMINI_COMMAND = 'agy';
