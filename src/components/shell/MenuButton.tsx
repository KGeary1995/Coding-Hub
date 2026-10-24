import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface MenuItem { label: string; detail?: string; onSelect: () => void; disabled?: boolean; current?: boolean }

/** A button that opens a keyboard-navigable menu (arrows, Home/End, Escape). Selecting an item closes it. */
export function MenuButton({ label, ariaLabel, items, className = '', active = false, disabled = false }: { label: ReactNode; ariaLabel: string; items: MenuItem[]; className?: string; active?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const options = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  useEffect(() => {
    if (!open) return;
    options()[0]?.focus();
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', outside);
    return () => window.removeEventListener('mousedown', outside);
  }, [open]);
  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) return;
    const all = options(); const index = all.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => { event.preventDefault(); all[(next + all.length) % all.length]?.focus(); };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(all.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') { event.preventDefault(); button.current?.focus(); } setOpen(false); }
  }
  return <div className={`tr-menu ${className}`} ref={root} onKeyDown={onKeyDown}>
    <button ref={button} className={`tr-menu-button ${active ? 'active' : ''}`} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(!open)}>{label}<span aria-hidden="true" className="tr-caret">▾</span></button>
    {open && <div className="tr-menu-list" role="menu" id={id} aria-label={ariaLabel}>
      {items.map((item) => <button key={item.label} role="menuitem" className={item.current ? 'current' : ''} aria-current={item.current ? 'page' : undefined} disabled={item.disabled} onClick={() => { setOpen(false); item.onSelect(); }}>
        <span>{item.label}</span>{item.detail && <small>{item.detail}</small>}
      </button>)}
    </div>}
  </div>;
}
