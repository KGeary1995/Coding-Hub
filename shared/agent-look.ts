/**
 * How a custom agent looks (docs/custom-agents.md): its colour and initials. No zod here, because the phone app uses it
 * and must not load zod (docs/architecture.md, Phone app).
 */
export const AGENT_PALETTE = ['#7c9cff', '#f2a65a', '#5ec4a8', '#d97ab7', '#c9b458', '#6fb3e0', '#e07a6f', '#9d8cf0'] as const;
/** The definition's own colour, or one from the palette picked by its id, so an agent keeps its colour on every computer. */
export function agentColor(agent: { id: string; color?: string }): string {
  if (agent.color && /^#[0-9a-fA-F]{6}$/.test(agent.color)) return agent.color;
  let sum = 0; for (const char of agent.id) sum = (sum * 31 + char.charCodeAt(0)) >>> 0;
  return AGENT_PALETTE[sum % AGENT_PALETTE.length];
}
/** One or two letters for its avatar: the first letters of its first two words, or its first two letters. */
export function agentInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}
/** What the window and phones know of a custom agent to show it: never its program or arguments. */
/** `chat`: its definition starts it as an ACP server (`acp`), so it can be a chat channel and sit at a Round Table. */
export interface AgentLook { id: string; name: string; color: string; initials: string; chat?: true }
export const agentLook = (agent: { id: string; name: string; color?: string; acp?: unknown }): AgentLook => ({ id: agent.id, name: agent.name, color: agentColor(agent), initials: agentInitials(agent.name), ...(agent.acp ? { chat: true as const } : {}) });
/** The permission levels' names, as Settings shows them (src/runtime/permissions.ts PERMISSION_LABEL). */
export const PERMISSION_NAMES = { ask: 'Ask', edits: 'Allow edits', full: 'Full access' } as const;
