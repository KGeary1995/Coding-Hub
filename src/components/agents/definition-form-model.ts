import { AGENT_ID, agentDefinitionSchema, definitionProblems, RESERVED_IDS, type AgentDefinition } from '../../../shared/agent-definition';

/**
 * The Agents page's form (docs/custom-agents.md) works on a draft: the definition as plain JSON, which may not be valid
 * yet. These turn its lists into the form's one-per-line text and back, and say what is wrong with it.
 */
export type Draft = Record<string, unknown>;
export const BLANK: Draft = { schema: 1, id: '', name: '', program: { command: '', args: [] }, status: { quietSeconds: 4 } };

export const toLines = (value: unknown) => Array.isArray(value) ? value.map(String).join('\n') : '';
/** One argument per line, kept as typed (spaces inside a line stay in that argument); blank lines are dropped. */
export const fromLines = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() !== '');
export const envToLines = (value: unknown) => value && typeof value === 'object' ? Object.entries(value as Record<string, string>).map(([key, item]) => `${key}=${item}`).join('\n') : '';
export function envFromLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fromLines(text)) { const at = line.indexOf('='); if (at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1); }
  return env;
}

/** An id from a name: lowercase letters, digits and -, starting with a letter, not a built-in agent's. */
export function idFrom(name: string): string {
  let id = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 31).replace(/-+$/, '');
  if (id.length < 2) id = id ? `${id}-agent` : '';
  return (RESERVED_IDS as readonly string[]).includes(id) ? `${id}-custom` : id;
}
export const validId = (id: string) => AGENT_ID.test(id) && !(RESERVED_IDS as readonly string[]).includes(id);

/** Sets one field at a path, leaving out empty optional parts so the definition stays as small as the person wrote it. */
export function setField(draft: Draft, path: string[], value: unknown): Draft {
  const next = structuredClone(draft) as Record<string, unknown>; let target = next;
  for (const key of path.slice(0, -1)) { if (!target[key] || typeof target[key] !== 'object') target[key] = {}; target = target[key] as Record<string, unknown>; }
  const last = path.at(-1)!; const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0 && last !== 'args' && last !== 'ask' && last !== 'edits' && last !== 'full') || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
  if (empty) delete target[last]; else target[last] = value;
  // A section left with nothing in it goes too.
  if (path.length > 1 && Object.keys(target).length === 0) delete (next as Record<string, unknown>)[path[0]];
  return next;
}
export const field = (draft: Draft, path: string[]): unknown => path.reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, draft);

/** The definition when it is valid, else the problems in plain sentences. */
export function checkDraft(draft: Draft): { definition: AgentDefinition; problems: [] } | { definition: null; problems: string[] } {
  const parsed = agentDefinitionSchema.safeParse(draft);
  return parsed.success ? { definition: parsed.data, problems: [] } : { definition: null, problems: definitionProblems(parsed.error) };
}
/** The JSON tab's text, and reading it back: null when it is not a JSON object. */
export const draftText = (draft: Draft) => JSON.stringify(draft, null, 2);
export function draftFrom(text: string): Draft | null { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Draft : null; } catch { return null; } }
