import { create } from 'zustand';
import type { LinkedComputer } from '../../shared/remote';
import type { ChannelEngine } from '../../shared/types';
import { workbench } from '../runtime/workbench';
import { refreshLinked } from '../runtime/linked-terminals';

/** The person's other computers, as the host last reported them: found through Drive, linked or not, and their channels. */
export const useLinkedStore = create<{ computers: LinkedComputer[]; addError: string }>(() => ({ computers: [], addError: '' }));

/** + Channel while a linked computer's tab is open: the channel is added there, in that computer's own workspace. */
export async function addLinkedChannel(id: string, engine: ChannelEngine) {
  useLinkedStore.setState({ addError: '' });
  try { await workbench({ action: 'linked-add', id, engine }); await refreshLinked(); }
  catch (error) { useLinkedStore.setState({ addError: (error as Error).message }); }
}

/** Linked computers' channels that are waiting for the person, for tab badges and the status bar. */
export const waitingOn = (computer: LinkedComputer) => computer.channels.filter((channel) => channel.running && channel.attention).length;
