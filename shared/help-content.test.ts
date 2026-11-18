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

describe('help covers what Trace has now', () => {
  it('finds the features added since the guide was written, and every view the top bar names', () => {
    for (const query of ['phone', 'round table', 'tailscale', 'linked computer', 'plan limit', 'alt+1', 'F1', 'chat', 'permissions full access', 'hierarchy', 'daily budget'])
      expect(searchHelp(query).length, query).toBeGreaterThan(0);
    for (const label of ['Workspace', 'Changes', 'Projects', 'Usage', 'Session history', 'Files', 'More tools', 'AI coaching', 'Tasks', 'Verification profiles', 'Accounts & connections', 'Shared memory', 'Shared rules', 'MCP servers', 'Skills & plugins', 'Settings', 'Workflow center', 'Terminal', 'Round Table (hierarchy)'])
      expect(searchHelp(label).length, label).toBeGreaterThan(0);
  });
  it('no longer says what the code stopped doing', () => {
    const all = HELP_TOPICS.flatMap((topic) => topic.sections.flatMap((section) => [...section.paragraphs, ...(section.bullets ?? [])])).join('\n');
    for (const stale of ['does not add permission-bypass flags', 'does not stage, discard, or commit', 'not an automatically resumed conversation', 'The footer shows the directory', 'two to eight', 'by their start date', 'stays unknown if any included run is unpriced', 'Connect accounts on the workspace', 'local terminal processes'])
      expect(all, stale).not.toContain(stale);
    // The three Permissions levels, as the control names them.
    for (const level of ['Ask', 'Allow edits', 'Full access']) expect(searchHelp(level).map((topic) => topic.id)).toContain('permissions');
  });
});

describe('help search regressions', () => {
  it('does not match field names or related topic IDs', () => {
    for (const key of ['paragraphs', 'related', 'summary', 'category']) expect(searchHelp(key).length).toBeLessThan(HELP_TOPICS.length);
  });
});
