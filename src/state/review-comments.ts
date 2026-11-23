import type { Session } from '../../shared/types';
import { channelsOf } from './workspace-store';

/**
 * A comment on a line of a diff in Changes, to send to the agent that made the change (1.32.2; an idea from herdr's
 * review plugins). `line` is the new file's line number, or the old one for a removed line (`removed`).
 */
export interface ReviewComment { id: string; path: string; line: number | null; removed: boolean; code: string; note: string }

/** The same folder, whatever the separators, case or trailing slash. */
const folderKey = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();

/** The running channels that work in this repository (in its root or a folder inside it), in channel order. */
export function reviewChannels(sessions: Session[], root: string): { session: Session; channel: number }[] {
  const base = folderKey(root);
  return channelsOf(sessions).map((session, index) => ({ session, channel: index + 1 })).filter(({ session }) => session.status === 'running' && session.config.engine !== 'shell' && session.runningCwd && (folderKey(session.runningCwd) === base || folderKey(session.runningCwd).startsWith(base + '/')));
}

/** One message with every comment: where each is, the code it is on, and what the person said. */
export function reviewMessage(comments: ReviewComment[]): string {
  const where = (comment: ReviewComment) => `${comment.path}${comment.line === null ? '' : ` line ${comment.line}${comment.removed ? ' (removed line)' : ''}`}`;
  const code = (comment: ReviewComment) => comment.code.trim() ? ` \`${comment.code.trim().slice(0, 200)}\`` : '';
  return [`Review comments on your changes (${comments.length === 1 ? 'one comment' : `${comments.length} comments`}, from Changes in Trace):`, '',
    ...comments.flatMap((comment, index) => [`${index + 1}. ${where(comment)}:${code(comment)}`, ...comment.note.trim().split(/\r?\n/).map((line) => `   ${line}`)]),
    '', 'Make these changes, or say why not.'].join('\n');
}
