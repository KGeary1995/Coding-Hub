import { useEffect, useState } from 'react';
import { LoaderCircle, Redo2, Undo2, X } from 'lucide-react';
import type { UndoPreview, UndoResult, UndoStatus } from '../../shared/undo';
import { workbench } from '../runtime/workbench';
import { receiveUndo, setUndoNotice, useUndoStore } from '../state/undo-store';
import { ConfirmStep } from './ConfirmStep';

/** The question before Undo or Redo: what happens, how many files change, and who else works in that folder. */
export function undoQuestion(channel: number, redo: boolean, preview: UndoPreview) {
  const others = preview.others.length ? ` ${preview.others.join(' and ')} also ${preview.others.length === 1 ? 'works' : 'work'} in this folder; ${preview.others.length === 1 ? 'its' : 'their'} changes go back too.` : '';
  return `${redo ? 'Put the files back as they were before the undo?' : `Put the files back as they were before CH${channel}'s last turn?`} ${preview.files} ${preview.files === 1 ? 'file changes' : 'files change'}.${others}`;
}

/** Undo last turn (1.39.0) on an agent's tile: Undo, or Redo after an undo, each asking first with what it changes. */
export function UndoTurnLine({ sessionId, channel, folder }: { sessionId: string; channel: number; folder: string | null }) {
  const status = useUndoStore((state) => state.bySession[sessionId]); const notice = useUndoStore((state) => state.notices[sessionId]);
  const [asking, setAsking] = useState<{ redo: boolean; question: string } | null>(null); const [working, setWorking] = useState(false);
  // What the host kept from before (a channel opened again after Trace restarted): asked once the tile knows its folder.
  useEffect(() => { if (folder) void workbench<UndoStatus>({ action: 'undo-status', sessionId }).then(receiveUndo, () => {}); }, [sessionId, folder]);
  const failed = (error: unknown) => setUndoNotice(sessionId, { text: error instanceof Error ? error.message : 'The files could not be put back.', failed: true });
  async function ask(redo: boolean) {
    setWorking(true); setUndoNotice(sessionId, null);
    try {
      const preview = await workbench<UndoPreview>({ action: 'undo-preview', sessionId, redo });
      setAsking({ redo, question: undoQuestion(channel, redo, preview) });
    } catch (error) { failed(error); } finally { setWorking(false); }
  }
  async function confirm(redo: boolean) {
    setAsking(null); setWorking(true);
    try {
      const result = await workbench<UndoResult>({ action: redo ? 'redo-turn' : 'undo-turn', sessionId }); receiveUndo(result.status);
      setUndoNotice(sessionId, { text: redo ? 'Files put back as they were before the undo.' : 'Files restored. Tell the agent if it should try again.', failed: false });
    } catch (error) { failed(error); } finally { setWorking(false); }
  }
  if (!status?.available || (!status.canUndo && !status.canRedo && !notice)) return null;
  return <div className={`auto-check undo-turn ${notice?.failed ? 'failed' : ''}`} role="status" title="Trace keeps a hidden copy of this project's files before each turn of the agent.">
    {working ? <LoaderCircle size={14} aria-hidden="true" className="spin" /> : <Undo2 size={14} aria-hidden="true" />}
    {asking ? <ConfirmStep question={asking.question} action={asking.redo ? 'Redo' : 'Undo last turn'} onConfirm={() => void confirm(asking.redo)} onCancel={() => setAsking(null)} />
      : <>
        <span>{notice?.text ?? (status.canUndo ? 'The last turn changed files.' : 'Files restored.')}</span>
        {status.canUndo && <button type="button" className="quiet-button small" disabled={working} title="Put every file back as it was before this agent's last turn" onClick={() => void ask(false)}><Undo2 size={12} aria-hidden="true" />Undo last turn</button>}
        {status.canRedo && <button type="button" className="quiet-button small" disabled={working} title="Take back the undo: the files as they were just before it" onClick={() => void ask(true)}><Redo2 size={12} aria-hidden="true" />Redo</button>}
        {notice && <button type="button" className="quiet-button small icon-button" aria-label="Dismiss" onClick={() => setUndoNotice(sessionId, null)}><X size={12} /></button>}
      </>}
  </div>;
}
