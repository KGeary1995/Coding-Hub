import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchSnippets, searchSummary } from './NativeHistory';
import type { NativeSearch } from '../../shared/workbench';

const conversation = { key: 'claude:default:1', id: '1', engine: 'claude' as const, directory: null, title: 'Claude', modifiedAt: '2026-11-24T00:00:00.000Z' };
const search = (part: Partial<NativeSearch>): NativeSearch => ({ query: 'login', results: [], partial: false, skipped: 0, ...part });

describe('search inside CLI conversations', () => {
  it('marks the words where each conversation mentions them, saying who wrote them', () => {
    expect(renderToStaticMarkup(<SearchSnippets engine="codex" snippets={[{ role: 'user', before: '…fix the ', match: 'Login', after: ' <test>' }, { role: 'assistant', before: '', match: 'login', after: ' fixed' }]} />))
      .toBe('<ul class="native-history-snippets"><li><span class="native-history-role">You:</span> …fix the <mark>Login</mark> &lt;test&gt;</li><li><span class="native-history-role">Codex:</span> <mark>login</mark> fixed</li></ul>');
  });
  it('says plainly what was found, when none match, and when the search stopped early or left files out', () => {
    expect(searchSummary(search({ results: [{ ...conversation, matches: 2, snippets: [] }] }))).toBe('1 conversation mentions “login”, newest first.');
    expect(searchSummary(search({}))).toBe('No conversation mentions “login”.');
    expect(searchSummary(search({ partial: true, skipped: 2 }))).toBe('No conversation searched so far mentions “login”. The search stopped early (it reads for up to 8 seconds and lists up to 50 conversations), so older ones may match too. More specific words narrow it. 2 files over 20 MB were not searched.');
  });
});
