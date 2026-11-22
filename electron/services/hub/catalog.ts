import { z } from 'zod';
import type { PublishedCatalog } from '../../../shared/hub';
import { DOWNLOADS_URL } from '../../../shared/updates';
import { CLAUDE_MODELS } from '../../../shared/model-name';
import { BUILT_IN_PRICES, PRICES_AS_OF, setPublishedPrices } from '../../../shared/model-prices';
import { load, save } from '../workbench/local-store';
import { preferencesSchema } from './preferences';

/**
 * The price list and Claude Code's model names, refreshed between releases (the person's choice, 2026-11-22): the
 * downloads page carries `catalog.json` (written by scripts/make-catalog.cjs with each release, and replaceable there
 * when a provider changes a price or names a new model), read at most once a day. It is data only (prices and model
 * IDs, checked here), and one older than what this Trace was built with is ignored, so a release is never set back.
 * Nothing about the person or their usage is sent: it is a plain download, from where updates come.
 */
export const CATALOG_URL = `${DOWNLOADS_URL}/download/catalog.json`;
const FILE = 'published-catalog.json'; const EVERY = 24 * 60 * 60 * 1000;
export const catalogSchema = z.object({
  asOf: z.iso.date(), prices: z.array(preferencesSchema.shape.prices.element).min(1).max(500),
  claudeModels: z.array(z.string().regex(/^claude-[a-z0-9-]{1,60}$/)).min(1).max(20),
}).strict();
const savedSchema = z.object({ checkedAt: z.iso.datetime(), catalog: catalogSchema.nullable() }).strict();

const builtIn = (): PublishedCatalog => ({ asOf: PRICES_AS_OF, prices: [...BUILT_IN_PRICES], claudeModels: [...CLAUDE_MODELS] });

export class PublishedCatalogService {
  private catalog: PublishedCatalog = builtIn(); private checkedAt = 0; private reading: Promise<void> | null = null;
  constructor(private root: string, private fetcher: typeof fetch = fetch) {
    try { const saved = load(root, FILE, savedSchema.nullable(), null); if (saved) { this.checkedAt = new Date(saved.checkedAt).getTime(); this.take(saved.catalog); } } catch { /* Unreadable: the built-in list, and a fresh download. */ }
  }
  /** A downloaded list is used only when it is newer than the one built in. */
  private take(catalog: PublishedCatalog | null) { this.catalog = catalog && catalog.asOf > PRICES_AS_OF ? catalog : builtIn(); setPublishedPrices(this.catalog === null || this.catalog.asOf === PRICES_AS_OF ? null : this.catalog); }
  current(): PublishedCatalog { return this.catalog; }
  /** Downloads the list if the last look was a day or more ago; a failed download leaves what there is. Never rejects. */
  refresh(now = Date.now()): Promise<void> {
    if (now - this.checkedAt < EVERY) return this.reading ?? Promise.resolve();
    this.reading ??= (async () => {
      try {
        const response = await this.fetcher(CATALOG_URL, { redirect: 'follow', signal: AbortSignal.timeout(15000) }); if (!response.ok) return;
        const text = await response.text(); if (text.length > 256 * 1024) return;
        const parsed = catalogSchema.safeParse(JSON.parse(text)); if (!parsed.success) return;
        this.take(parsed.data); this.checkedAt = now; save(this.root, FILE, { checkedAt: new Date(now).toISOString(), catalog: parsed.data });
      } catch { /* Offline, or not a list: tried again on the next call a day on, or at the next start. */ }
    })().finally(() => { this.reading = null; });
    return this.reading;
  }
}
