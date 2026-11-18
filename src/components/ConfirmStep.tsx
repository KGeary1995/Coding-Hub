/**
 * A question in place, before an action that cannot be undone (closing a running channel, removing a task): the action
 * and Keep, where the button was. Keep has focus, so Enter, Escape or a second stray click leaves things as they are.
 */
export function ConfirmStep({ question, action, onConfirm, onCancel, className = 'quiet-button', actionClassName = className, busy = false }: { question: string; action: string; onConfirm: () => void; onCancel: () => void; className?: string; actionClassName?: string; busy?: boolean }) {
  return <span className="confirm-step" role="group" aria-label={question} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
    <span className="confirm-step-question">{question}</span>
    <button type="button" className={actionClassName} disabled={busy} onClick={onConfirm}>{action}</button>
    <button type="button" className={className} autoFocus onClick={onCancel}>Keep</button>
  </span>;
}

/** A channel whose CLI runs is stopped by Close, so Close asks first; one that is not running closes at once. */
export const closeAsks = (status: string) => status === 'running';
