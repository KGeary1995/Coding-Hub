import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { removePastedImage, usePastedImages, type PastedImage } from '../state/pasted-images';

const NONE: PastedImage[] = [];
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Images pasted or dropped into a channel, under its terminal: attached ones, which go with the next message, and sent
 * ones, with when they were sent. The CLI keeps its own copy and shows only [Image #N] or the file path in its
 * conversation (a terminal draws text); this is where the person sees what they sent.
 */
export function PastedImages({ sessionId }: { sessionId: string }) {
  const images = usePastedImages((state) => state.images[sessionId] ?? NONE);
  const [open, setOpen] = useState<PastedImage | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  if (!images.length) return null;
  const attached = images.filter((image) => !image.sentAt); const sent = images.filter((image) => image.sentAt);
  const thumb = (image: PastedImage, small = false) => <li key={image.id} className={small ? 'sent' : ''}>
    <button className="pasted-thumb" title={`#${image.number} · ${image.label}${image.sentAt ? ` · sent ${time(image.sentAt)}` : ''} · click to enlarge`} aria-label={`Enlarge image ${image.number}`} onClick={() => setOpen(image)}><img src={image.thumbnail} alt="" /><span className="pasted-number">#{image.number}</span></button>
    {!image.sentAt && <button className="pasted-remove" aria-label={`Remove image ${image.number} from the strip`} title="Remove from the strip (the CLI keeps what it was given)" onClick={() => removePastedImage(sessionId, image.id)}><X size={11} /></button>}
  </li>;
  return (
    <div className="pasted-images" role="region" aria-label="Pasted images">
      {attached.length > 0 && <div className="pasted-group">
        <span className="pasted-heading">Attached · sent with your next message</span>
        <ul>{attached.map((image) => thumb(image))}</ul>
      </div>}
      {sent.length > 0 && <div className="pasted-group sent">
        <span className="pasted-heading">Sent{sent.length === 1 ? ` ${time(sent[0].sentAt!)}` : ''}</span>
        <ul>{sent.slice().reverse().map((image) => thumb(image, true))}</ul>
      </div>}
      <dialog ref={dialog} className="pasted-viewer" onClose={() => setOpen(null)} onClick={(event) => { if (event.target === event.currentTarget) setOpen(null); }}>
        {open && <><header><span>#{open.number} · {open.label}{open.sentAt ? ` · sent ${time(open.sentAt)}` : ' · attached'}</span><button className="quiet-button" aria-label="Close image" onClick={() => setOpen(null)}><X size={14} /></button></header><img src={open.full} alt={open.label} /></>}
      </dialog>
    </div>
  );
}
