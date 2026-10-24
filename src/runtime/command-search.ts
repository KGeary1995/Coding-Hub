/** Command menu scopes, and the prefix character that selects each one (docs/design/trace, sheet 06). */
export const COMMAND_SCOPES = [
  { id: 'all', label: 'All', prefix: '' },
  { id: 'actions', label: 'Actions', prefix: '>' },
  { id: 'channels', label: 'Channels', prefix: '@' },
  { id: 'files', label: 'Files', prefix: '/' },
  { id: 'memory', label: 'Memory', prefix: '#' },
] as const;
export type CommandScope = typeof COMMAND_SCOPES[number]['id'];

/** A leading prefix character picks the scope; the rest is the search text. */
export function parseQuery(input: string, scope: CommandScope): { scope: CommandScope; text: string } {
  const prefixed = COMMAND_SCOPES.find((item) => item.prefix && input.startsWith(item.prefix));
  return prefixed ? { scope: prefixed.id, text: input.slice(1).trimStart() } : { scope, text: input.trim() };
}

/** Where the search text first appears in a label, case-insensitively, for highlighting; null when absent. */
export function matchRange(label: string, text: string): [number, number] | null {
  if (!text) return null;
  const start = label.toLowerCase().indexOf(text.toLowerCase());
  return start < 0 ? null : [start, start + text.length];
}

/** Whether local file and memory search should run: it reads files, so it waits for a few characters. */
export const searchesFiles = (scope: CommandScope, text: string) => (scope === 'files' || scope === 'memory') ? text.length >= 2 : scope === 'all' && text.length >= 3;

/** A search hit's absolute file path as the repository-relative, slash-separated path Files uses; null when outside it. */
export function repositoryRelative(file: string, directory: string): string | null {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = normalize(file); const root = normalize(directory);
  // Windows paths compare without case; POSIX paths keep it.
  const same = /^[a-z]:\//i.test(root) ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;
  if (!same(target.slice(0, root.length), root) || target[root.length] !== '/') return null;
  return target.slice(root.length + 1) || null;
}
