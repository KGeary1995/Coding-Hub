import { create } from 'zustand';
import type { Session } from '../../shared/types';
import { channelDirectory } from './channel-names';
import { useWorkspaceStore } from './workspace-store';

/**
 * The channel the person last clicked or typed in (several projects, step 3: docs/plans/several-projects.md). Changes
 * and Files open on its folder, so with channels in several repositories they show the one being worked in, not
 * always the workspace root. Not saved: a restarted Trace starts at the root again.
 */
export const useLastChannel = create<{ sessionId: string | null }>(() => ({ sessionId: null }));
// Another project opened: its Changes and Files start at its root, not on a channel the last project kept.
useWorkspaceStore.subscribe((state, previous) => { if (state.rootDirectory !== previous.rootDirectory && useLastChannel.getState().sessionId) useLastChannel.setState({ sessionId: null }); });
export function useChannel(sessionId: string) { if (useLastChannel.getState().sessionId !== sessionId) useLastChannel.setState({ sessionId }); }

/** Where Changes and Files start: the channel reviewed, else the last one used when its folder is not the root, else the root ('workspace'). */
export function startingChoice(channels: Session[], rootDirectory: string | null, reviewId: string | null, lastId: string | null): string {
  if (reviewId && channels.some((session) => session.id === reviewId)) return reviewId;
  const last = channels.find((session) => session.id === lastId); const folder = last && channelDirectory(last, rootDirectory);
  return last && folder && folder !== rootDirectory ? last.id : 'workspace';
}
