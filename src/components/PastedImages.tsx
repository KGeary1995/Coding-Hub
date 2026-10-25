import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { removePastedImage, usePastedImages, type PastedImage } from '../state/pasted-images';

const NONE: PastedImage[] = [];

/** Thumbnails of the images pasted or dropped into a channel. They are Trace's copy for the person; the CLI keeps its own. */
export function PastedImages({ sessionId }: { sessionId: string }) {
  const images = usePastedImages((state) => state.images[sessionId] ?? NONE);
  const [open, setOpen] = useState<PastedImage | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  if (!images.length) return null;
  return (
    <div className="pasted-images" role="region" aria-label="Pasted images">
      <ul>
        {images.map((image) => <li key={image.id}>
          <button className="pasted-thumb" title={`${image.label} · click to enlarge`} aria-label={`Enlarge ${image.label}`} onClick={() => setOpen(image)}><img src={image.thumbnail} alt="" /></button>
          <button className="pasted-remove" aria-label={`Remove ${image.label} from this strip`} title="Remove from strip (the agent keeps it)" onClick={() => removePastedImage(sessionId, image.id)}><X size={11} /></button>
        </li>)}
      </ul>
      <span className="pasted-count">{images.length} {images.length === 1 ? 'image' : 'images'} pasted</span>
      <dialog ref={dialog} className="pasted-viewer" onClose={() => setOpen(null)} onClick={(event) => { if (event.target === event.currentTarget) setOpen(null); }}>
        {open && <><header><span>{open.label}</span><button className="quiet-button" aria-label="Close image" onClick={() => setOpen(null)}><X size={14} /></button></header><img src={open.full} alt={open.label} /></>}
      </dialog>
    </div>
  );
}
