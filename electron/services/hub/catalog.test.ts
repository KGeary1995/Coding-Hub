import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_MODELS } from '../../../shared/model-name';
import { builtInRate, PRICES_AS_OF, setPublishedPrices } from '../../../shared/model-prices';
import { CATALOG_URL, PublishedCatalogService } from './catalog';

const roots: string[] = [];
afterEach(() => { setPublishedPrices(null); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-')); roots.push(root); return root; };
const answering = (body: unknown, status = 200) => { const asked: string[] = []; const fetcher = (async (url: string) => { asked.push(String(url)); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); }) as unknown as typeof fetch; return { fetcher, asked }; };
const newer = { asOf: '2099-01-01', prices: [{ model: 'claude-fable-5-2', input: 6, output: 30, cacheRead: 0.15, cacheWrite: 12 }, { model: 'claude-nova-6', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 2 }], claudeModels: ['claude-nova-6', 'claude-fable-5-2'] };

describe('the price list and model names from the downloads page', () => {
  it('starts from what Trace was built with, and takes a newer list once a day', async () => {
    const root = temporary(); const { fetcher, asked } = answering(newer); const catalog = new PublishedCatalogService(root, fetcher);
    expect(catalog.current()).toMatchObject({ asOf: PRICES_AS_OF, claudeModels: [...CLAUDE_MODELS] }); expect(builtInRate('claude-fable-5-2')?.input).toBe(8);
    await catalog.refresh();
    expect(asked).toEqual([CATALOG_URL]); expect(catalog.current().claudeModels).toEqual(['claude-nova-6', 'claude-fable-5-2']);
    // The new prices are what estimates use, and a model the new list names is priced.
    expect(builtInRate('claude-fable-5-2')?.input).toBe(6); expect(builtInRate('claude-nova-6')?.output).toBe(2);
    // Not asked again within the day, and kept for the next start without asking.
    await catalog.refresh(); expect(asked).toHaveLength(1);
    setPublishedPrices(null); const again = new PublishedCatalogService(root, answering('never asked').fetcher);
    expect(again.current().asOf).toBe('2099-01-01'); expect(builtInRate('claude-nova-6')?.input).toBe(1);
  });
  it('keeps the built-in list when the download is older, missing, too odd to be a list, or fails', async () => {
    for (const body of [{ ...newer, asOf: '2020-01-01' }, { ...newer, prices: [] }, { ...newer, claudeModels: ['rm -rf /'] }, { ...newer, extra: true }, 'not json']) {
      const catalog = new PublishedCatalogService(temporary(), answering(body).fetcher); await catalog.refresh();
      expect(catalog.current().asOf, JSON.stringify(body)).toBe(PRICES_AS_OF); expect(builtInRate('claude-fable-5-2')?.input).toBe(8);
    }
    const missing = new PublishedCatalogService(temporary(), answering('', 404).fetcher); await missing.refresh(); expect(missing.current().asOf).toBe(PRICES_AS_OF);
    const offline = new PublishedCatalogService(temporary(), (async () => { throw new Error('offline'); }) as unknown as typeof fetch); await offline.refresh(); expect(offline.current().asOf).toBe(PRICES_AS_OF);
  });
});
