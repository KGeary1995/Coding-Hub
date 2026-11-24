import { create } from 'zustand';
import type { AgentEntry, AgentList } from '../../shared/agents';
import { agentLook, type AgentLook } from '../../shared/agent-look';
import { workbench } from '../runtime/workbench';

/**
 * The custom agents on this computer (docs/custom-agents.md), as the host lists them: for the Agents page, + Channel and
 * how a custom channel looks. Read at start and after each change; the host is the one that checks and runs them.
 */
export const useAgentStore = create<{ agents: AgentEntry[]; loaded: boolean; error: string }>(() => ({ agents: [], loaded: false, error: '' }));
export async function refreshAgents() {
  try { const list = await workbench<AgentList>({ action: 'agent-list' }); useAgentStore.setState({ agents: list.agents, loaded: true, error: '' }); }
  catch (error) { useAgentStore.setState({ loaded: true, error: (error as Error).message }); }
}
/** The store's list after a change the host answered with the new list. */
export const setAgents = (list: AgentList) => useAgentStore.setState({ agents: list.agents, loaded: true, error: '' });
/** How a custom channel's agent looks; one that is gone keeps a look from its id. */
export const lookOf = (agents: AgentEntry[], id: string): AgentLook => agents.find((agent) => agent.id === id)?.look ?? agentLook({ id, name: id });
/** The look is made outside the selector: a selector must return what the store holds, or zustand renders again and again. */
export const useAgentLook = (id: string): AgentLook => { const entry = useAgentStore((state) => state.agents.find((agent) => agent.id === id)); return entry?.look ?? agentLook({ id, name: id }); };
export const useAgent = (id: string) => useAgentStore((state) => state.agents.find((agent) => agent.id === id) ?? null);
