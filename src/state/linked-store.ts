import { create } from 'zustand';
import type { LinkedComputer } from '../../shared/remote';

/** The person's other computers, as the host last reported them: found through Drive, linked or not, and their channels. */
export const useLinkedStore = create<{ computers: LinkedComputer[] }>(() => ({ computers: [] }));

/** Linked computers' channels that are waiting for the person, for tab badges and the status bar. */
export const waitingOn = (computer: LinkedComputer) => computer.channels.filter((channel) => channel.running && channel.attention).length;
