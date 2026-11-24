import type { AgentLook } from './agent-look';

/**
 * A definition's shape (docs/custom-agents.md), written out here because the phone may load this file and must not load
 * zod; shared/agent-definition.ts checks definitions and that its schema and this agree.
 */
export interface AgentDefinition {
  schema: 1; id: string; name: string; color?: string;
  program: { command: string; args?: string[] };
  version?: { args: string[] };
  models?: { choices?: string[]; listArgs?: string[] | null; arg: string[] };
  permissions?: { ask: string[]; edits: string[]; full: string[] };
  resume?: { args: string[]; listArgs?: string[] | null };
  firstRequest?: { args: string[] };
  status?: { osc?: boolean; waiting?: string[]; turnEnd?: string[]; quietSeconds?: number };
  mcp?: { format: 'claude-json' | 'codex-toml' | 'none'; args?: string[] };
  instructions?: { args: string[] } | { env: string };
  env?: Record<string, string>;
}

/** A custom agent as the Agents page lists it (docs/custom-agents.md). Types only, so the phone can import them. */
export interface AgentEntry {
  id: string; look: AgentLook;
  /** Null when its file could not be read or is not a valid definition (`problem` says why). */
  definition: AgentDefinition | null;
  /** Confirmed on this computer: only an active agent starts. A definition saved here is; one copied in is not until confirmed. */
  active: boolean;
  /** Where its program was found on this computer, or null (`problem` says why). */
  program: string | null; problem: string | null;
}
export interface AgentList { agents: AgentEntry[] }
/** What Test start showed: the command it ran and what came back. */
export interface AgentTestResult { command: string; output: string; exitCode: number | null; timedOut: boolean }
/** A definition Claude Code drafted from the program's help, and what the schema says about it (empty when valid). */
export interface AgentDraft { definition: Record<string, unknown>; problems: string[] }
export type AgentRequest =
  | { action: 'agent-list' }
  /** `replaces`: the id of the definition being edited, when the id changed. */
  | { action: 'agent-save'; definition: unknown; replaces?: string }
  | { action: 'agent-remove'; id: string }
  | { action: 'agent-activate'; id: string }
  | { action: 'agent-test'; definition: unknown }
  | { action: 'agent-draft'; command: string }
  | { action: 'agent-models'; id: string };
