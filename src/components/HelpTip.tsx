import { useId, useState } from 'react';

/**
 * The "?" beside a heading: its words on hover (the tooltip), and on a press, Enter or a tap as a note under it, which a
 * second press, Escape or moving on closes. Before 1.31.5 they were a tooltip only, out of reach of the keyboard, touch
 * and screen readers (which heard only "Help: …").
 */
export function HelpTip({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false); const id = useId();
  return <span className="ui-help-wrap">
    <button type="button" className="ui-help" aria-label={label} title={text} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} onBlur={() => setOpen(false)}
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } }} />
    {open && <span id={id} role="note" className="ui-help-note">{text}</span>}
  </span>;
}
