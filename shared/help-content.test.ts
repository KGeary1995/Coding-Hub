import { describe, expect, it } from 'vitest';
import { HELP_TOPICS, searchHelp } from './help-content';
describe('local help navigation and search', () => {
  it('resolves every related link and provides the requested AI concepts', () => {
    const ids = new Set(HELP_TOPICS.map((t) => t.id)); expect(ids.size).toBe(HELP_TOPICS.length); for (const topic of HELP_TOPICS) for (const related of topic.related) expect(ids.has(related)).toBe(true);
    for (const id of ['agents', 'models', 'tokens', 'mcp', 'skills', 'plugins', 'hooks', 'rules', 'memory', 'permissions']) expect(ids.has(id)).toBe(true);
  });
  it('searches article text as well as titles, combines terms, and respects categories', () => {
    expect(searchHelp('  MODEL CONTEXT PROTOCOL  ').map((t) => t.id)).toContain('mcp'); expect(searchHelp('reasoning tokens', 'Agents & models').map((t) => t.id)).toContain('tokens'); expect(searchHelp('reasoning tokens', 'Rules & memory')).toHaveLength(0); expect(searchHelp('nonexistentsearchterm')).toHaveLength(0); expect(searchHelp('')).toHaveLength(HELP_TOPICS.length);
  });
});
