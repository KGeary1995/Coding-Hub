import { create } from 'zustand';
import type { Session } from '../../shared/types';
import { channelName, sessionTopic } from '../../shared/channel-name';
import { useWorkspaceStore } from './workspace-store';

/** The latest title each channel's CLI gave its terminal, kept for the run (see sessionTopic). */
export const useTitleStore = create<{ titles: Record<string, string> }>(() => ({ titles: {} }));
export function setTerminalTitle(sessionId: string, raw: string) {
  // CLIs animate a spinner in front of their title many times a second while working; only a change in the words
  // themselves is stored, so a busy channel does not redraw its tile on every frame.
  const title = raw.replace(/[\x00-\x1f\x7f]/g, '').replace(/^[^\p{L}\p{N}"'(\[]+/u, '').trim();
  if (useTitleStore.getState().titles[sessionId] === title) return;
  useTitleStore.setState((state) => ({ titles: { ...state.titles, [sessionId]: title } }));
}
export function clearTerminalTitle(sessionId: string) {
  if (!(sessionId in useTitleStore.getState().titles)) return;
  useTitleStore.setState((state) => { const titles = { ...state.titles }; delete titles[sessionId]; return { titles }; });
}

/** The folder a channel works in: where it runs, else where it will start. */
export const channelDirectory = (session: Session, rootDirectory: string | null) => session.runningCwd ?? (session.binding.mode === 'independent' ? session.binding.cwd : rootDirectory);

/** A channel's name (its folder unless the person named it) and, while running, what it is working on. */
export function useChannelName(session: Session) {
  const rootDirectory = useWorkspaceStore((state) => state.rootDirectory);
  const title = useTitleStore((state) => state.titles[session.id]);
  const name = channelName({ engine: session.config.engine, title: session.title, cwd: channelDirectory(session, rootDirectory) });
  const topic = title && session.status === 'running' ? sessionTopic(title, session.config.engine, name) : null;
  return { name, topic };
}
/** The same, outside React (command menu labels and the like). */
export function channelNameNow(session: Session) {
  return channelName({ engine: session.config.engine, title: session.title, cwd: channelDirectory(session, useWorkspaceStore.getState().rootDirectory) });
}
