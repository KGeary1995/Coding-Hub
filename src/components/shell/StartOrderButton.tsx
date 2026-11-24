import { ListOrdered, Square } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { channelsOf, useWorkspaceStore } from '../../state/workspace-store';
import { cancelStartOrder, startInOrder, useStartOrder } from '../../runtime/start-order';

/** Start in order on the top bar: shown when a channel has a step; while it runs, where it is, and Stop. */
export function StartOrderButton() {
  const steps = useWorkspaceStore(useShallow((state) => channelsOf(state.sessions).filter((session) => session.startup).map((session) => session.id)));
  const { progress, notice } = useStartOrder();
  if (!steps.length && !progress) return null;
  const where = progress && `Step ${progress.step} of ${progress.steps}: CH${progress.channel}${progress.waiting ? `, waiting for “${progress.waiting}”` : ''}`;
  return <span className="tr-start-order">
    {progress
      ? <button className="button secondary small" title={where ?? undefined} aria-label={`${where}. Stop starting in order`} onClick={cancelStartOrder}><Square size={14} aria-hidden="true" /><span className="tr-wide-label">{where}</span></button>
      : <button className="button secondary small" title="Start the channels that have a step, lowest step first (each channel’s settings: Start in order)" onClick={() => void startInOrder()}><ListOrdered size={14} aria-hidden="true" /><span className="tr-wide-label">Start in order</span></button>}
    {notice && !progress && <span className="ui-badge warning" role="status" title={notice}>{notice}<button type="button" className="quiet-button small" aria-label="Dismiss" onClick={() => useStartOrder.setState({ notice: null })}>×</button></span>}
  </span>;
}
