import type { PriceRate } from './hub';

/**
 * The providers' published prices (USD per million tokens), so cost estimates need nothing typed in. From
 * https://platform.claude.com/docs/en/about-claude/pricing, https://developers.openai.com/api/docs/pricing and (Gemini,
 * from 1.28) https://aistudio.google.com/docs/pricing, last checked on PRICES_AS_OF; check both again with each release. A rate the person enters in Settings for the same model
 * comes first (rateFor in electron/services/hub/telemetry.ts).
 *
 * What the estimates leave out: a prompt over a model's long-context threshold costs more (Claude Haiku 5.5 over 100K
 * tokens, OpenAI's models over 272K), and the logs Trace reads do not say which requests those were.
 */
export const PRICES_AS_OF = '2026-11-25';

/**
 * Claude: cache reads at the model's own rate. Cache writes at the 1-hour rate (2x input): Claude Code writes its
 * prompt cache for one hour (its logs here showed no 5-minute writes), and Trace reads one cache-write count.
 */
const claude = (model: string, input: number, output: number, cacheRead: number): PriceRate => ({ model, input, output, cacheRead, cacheWrite: input * 2 });
/**
 * Gemini: the standard paid tier; output includes thinking, and caching is implicit (a read price, no write price).
 * Gemini CLI on a subscription is not billed by the token: these are what the same use would cost through the API.
 */
const gemini = (model: string, input: number, output: number, cacheRead: number): PriceRate => ({ model, input, output, cacheRead, cacheWrite: 0 });
/** A price Google has announced to change on a date (YYYY-MM-DD): the one in effect when Trace starts. */
const from = (date: string, before: [number, number, number], after: [number, number, number]) => new Date().toISOString().slice(0, 10) >= date ? after : before;
/** OpenAI: cached input at its own rate (at the input rate where none is listed); Codex reports no cache writes. */
const openai = (model: string, input: number, cacheRead: number | null, output: number): PriceRate => ({ model, input, output, cacheRead: cacheRead ?? input, cacheWrite: 0 });

export const BUILT_IN_PRICES: readonly PriceRate[] = [
  claude('claude-fable-5-2', 8, 40, 0.2), claude('claude-mythos-5-2', 8, 40, 0.2),
  claude('claude-fable-5-1', 10, 50, 0.25), claude('claude-mythos-5-1', 10, 50, 0.25),
  claude('claude-fable-5', 10, 50, 1), claude('claude-mythos-5', 10, 50, 1),
  claude('claude-opus-5-5', 4, 20, 0.2), claude('claude-opus-5', 5, 25, 0.5), claude('claude-opus-4-8', 5, 25, 0.5), claude('claude-opus-4-7', 5, 25, 0.5),
  claude('claude-opus-4-6', 5, 25, 0.5), claude('claude-opus-4-5', 5, 25, 0.5), claude('claude-opus-4-1', 15, 75, 1.5), claude('claude-opus-4', 15, 75, 1.5),
  claude('claude-sonnet-5-5', 2, 10, 0.1), claude('claude-sonnet-5', 2, 10, 0.2), claude('claude-sonnet-4-6', 3, 15, 0.3), claude('claude-sonnet-4-5', 3, 15, 0.3), claude('claude-sonnet-4', 3, 15, 0.3),
  claude('claude-haiku-5-5', 0.1, 0.5, 0.01), claude('claude-haiku-4-5', 1, 5, 0.1),
  openai('gpt-6.2-astra', 8, 0.4, 40), openai('gpt-6.2-sol', 2, 0.1, 10), openai('gpt-6-astra', 10, 1, 50), openai('gpt-6.1-sol', 2, 0.1, 10), openai('gpt-6.1-terra', 1, 0.05, 5),
  openai('gpt-6-luna', 0.1, 0.01, 0.5), openai('gpt-6-sol', 2, 0.2, 10), /* Promotional until 2026-11-30 (the page does not say the price after): check again then. */ openai('gpt-5.6-sol', 4, 0.4, 20), openai('gpt-5.6-terra', 2, 0.2, 12), openai('gpt-5.6-luna', 0.2, 0.02, 1.2),
  openai('gpt-5.5', 5, 0.5, 30), openai('gpt-5.5-pro', 30, null, 180), openai('gpt-5.4', 2.5, 0.25, 15), openai('gpt-5.4-pro', 30, null, 180), openai('gpt-5.4-mini', 0.75, 0.075, 4.5), openai('gpt-5.4-nano', 0.2, 0.02, 1.25),
  openai('gpt-5.3-codex', 1.75, 0.175, 14), openai('gpt-5.2', 1.75, 0.175, 14), openai('gpt-5.2-pro', 21, null, 168), openai('gpt-5.1', 1.25, 0.125, 10),
  openai('gpt-5', 1.25, 0.125, 10), openai('gpt-5-mini', 0.25, 0.025, 2), openai('gpt-5-nano', 0.05, 0.005, 0.4), openai('gpt-5-pro', 15, null, 120),
  gemini('gemini-4-neon', 3, 15, 0.15), gemini('gemini-4-hydrogen', 1.5, 7.5, 0.075),
  // Argon and Carbon double on 2026-12-01, the Flash models on 2027-01-01 (as the price page announces).
  gemini('gemini-4-argon', ...from('2026-12-01', [2, 10, 0.1], [4, 20, 0.2])), gemini('gemini-4-carbon', ...from('2026-12-01', [2, 10, 0.1], [4, 20, 0.2])),
  gemini('gemini-3.8-flash', ...from('2027-01-01', [0.75, 3.75, 0.075], [1.5, 7.5, 0.15])), gemini('gemini-3.6-flash', ...from('2027-01-01', [0.75, 3.75, 0.075], [1.5, 7.5, 0.15])),
  gemini('gemini-3.5-flash-lite', 0.3, 2.5, 0.03),
];

/**
 * A model name reduced to what identifies its price: case, spaces and dots for dashes, and a release date
 * (`-20261101`) do not matter, so "Claude Opus 5.5", `claude-opus-5-5` and `claude-opus-5-5-20260401` are one model. A
 * context-size variant such as `[1m]` stays in the name (`claude-opus-5-5-1m`).
 */
export const baseModel = (model: string) => model.trim().toLowerCase().replace(/-\d{8}(?=$|\[)/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const byModel = (rates: readonly PriceRate[]) => new Map(rates.map((rate) => [baseModel(rate.model), rate]));
const BUILT_IN = byModel(BUILT_IN_PRICES);
/** The list in use in this process: the built-in one, or a newer one from the downloads page (electron/services/hub/catalog.ts). */
let published = BUILT_IN;
/** Takes a newer published list for this process's estimates; null goes back to the built-in one. */
export function setPublishedPrices(catalog: { prices: readonly PriceRate[] } | null) { published = catalog ? byModel(catalog.prices) : BUILT_IN; }
/** The published price of a model; the `[1m]` variant of one costs the same (the listed models include their full context). */
/**
 * Gemini CLI names a model with what it adds to it: an effort (`gemini-4-neon-high`), `-tiered` and, on a trial of a
 * model, `-trial` (`gemini-4-argon-trial`). The price list has the model itself, so those endings are taken off. A
 * trial is priced as its model: Google lists no price of its own for one.
 */
const geminiModel = (base: string) => base.startsWith('gemini-') ? base.replace(/-(low|medium|high|xhigh|max)$/, '').replace(/-tiered$/, '').replace(/-trial$/, '') : base;
export function builtInRate(model: string): PriceRate | undefined { const base = baseModel(model); return published.get(base) ?? published.get(base.replace(/-1m$/, '')) ?? published.get(geminiModel(base)); }
