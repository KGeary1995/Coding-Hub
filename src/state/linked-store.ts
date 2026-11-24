import { create } from 'zustand';
import type { LinkedComputer } from '../../shared/remote';
import type { ChannelEngine } from '../../shared/types';
import type { AgentLook } from '../../shared/agent-look';
import { workbench } from '../runtime/workbench';
import { refreshLinked } from '../runtime/linked-terminals';

/** The person's other computers, as the host last reported them: found through Drive, linked or not, and their channels. */
export const useLinkedStore = create<{ computers: LinkedComputer[]; addError: string; /** Each computer's custom agents, read when its tab opens. */ agents: Record<string, AgentLook[]> }>(() => ({ computers: [], addError: '', agents: {} }));

/** + Channel while a linked computer's tab is open: the channel is added there, in that computer's own workspace. `agent`: one of its custom agents. */
export async function addLinkedChannel(id: string, engine: ChannelEngine, agent?: string) {
  useLinkedStore.setState({ addError: '' });
  try { await workbench({ action: 'linked-add', id, engine, ...(agent ? { agent } : {}) }); await refreshLinked(); }
  catch (error) { useLinkedStore.setState({ addError: (error as Error).message }); }
}
/** The custom agents turned on on that computer (docs/custom-agents.md); none when it can't say. */
export async function refreshLinkedAgents(id: string) {
  const agents = await workbench<AgentLook[]>({ action: 'linked-agents', id }).catch(() => [] as AgentLook[]);
  useLinkedStore.setState((state) => ({ agents: { ...state.agents, [id]: agents } }));
}

/** Linked computers' channels that are waiting for the person, for tab badges and the status bar. */
export const waitingOn = (computer: LinkedComputer) => computer.channels.filter((channel) => channel.running && channel.attention).length;
