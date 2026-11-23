import { Fragment, memo, useState, type ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { workbench } from '../../runtime/workbench';

/**
 * Claude's replies, formatted: headings, paragraphs, lists, quotes, tables, fenced code and inline code, bold, italic
 * and links. Everything becomes React elements (never HTML from the reply), so nothing in a reply can run in Trace.
 * Links never navigate the window: clicking one shows its address, to copy, and to open in the browser when it is a
 * web address. Memoized by text, so a settled message is not parsed again while another one streams.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="chat-markdown">{blocks(text)}</div>;
});

/** The address, when it is one Trace opens in the browser (http or https); anything else (a file path, javascript:) is not. */
export function webAddress(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null; } catch { return null; }
}
/** Opens a web address outside Trace: through the host on the desktop (which checks it again), in a new tab on the phone. */
export async function openAddress(url: string) {
  if (window.codingHub) { await workbench({ action: 'flow-open-link', url }); return; }
  // With noopener, window.open returns null even when the tab opened, so its result says nothing.
  window.open(url, '_blank', 'noopener,noreferrer');
}
/** Copies through the host on the desktop (the window may not write the clipboard itself); the phone page is on HTTPS. */
export async function copyAddress(url: string) {
  if (window.codingHub) { const result = await window.codingHub.copyText(url); if (!result.ok) throw new Error(result.error.message); return; }
  await navigator.clipboard.writeText(url);
}
/** A fenced block of code with its language and Copy above it (1.31.2), so a command or a file can be taken whole. */
function CodeBlock({ code, language }: { code: string; language: string | undefined }) {
  const [note, setNote] = useState('');
  const copy = () => { void copyAddress(code).then(() => setNote('Copied'), (e: Error) => setNote(e.message || 'Not copied')).then(() => setTimeout(() => setNote(''), 2000)); };
  return <div className="chat-code-block"><div className="chat-code-head"><span>{language || 'code'}</span><button type="button" className="quiet-button small" aria-label={`Copy this ${language || 'code'}`} onClick={copy}><Copy size={12} aria-hidden="true" /><span role="status">{note || 'Copy'}</span></button></div>
    <pre className="chat-code" data-language={language || undefined}><code>{code}</code></pre></div>;
}
function ChatLink({ url, children }: { url: string; children: ReactNode }) {
  const [open, setOpen] = useState(false); const [note, setNote] = useState('');
  const web = webAddress(url);
  const act = (job: () => Promise<unknown>, done: string) => { setNote(''); void job().then(() => setNote(done), (e: Error) => setNote(e.message || 'That did not work.')); };
  return <span className="chat-link-wrap">
    <button type="button" className="chat-link" title={url} aria-expanded={open} onClick={() => { setOpen(!open); setNote(''); }}>{children}</button>
    {open && <span className="chat-link-menu" role="group" aria-label="Link">
      <code className="chat-link-address">{url}</code>
      {web && <button type="button" className="quiet-button" onClick={() => act(() => openAddress(web), 'Opened in your browser.')}>Open in browser</button>}
      <button type="button" className="quiet-button" onClick={() => act(() => copyAddress(url), 'Copied.')}>Copy address</button>
      {note && <small role="status">{note}</small>}
    </span>}
  </span>;
}

/** `links`: false inside a link's own text, so a link never holds another. */
function inline(text: string, key = 'i', links = true): ReactNode[] {
  const out: ReactNode[] = []; let rest = text; let index = 0;
  // Underscores inside a word (snake_case, an address) are not emphasis. Last: a bare web address, with balanced
  // parentheses but without the punctuation that ends a sentence around it.
  const pattern = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|(?<!\w)__([^_]+)__|\*([^*\s][^*]*)\*|(?<!\w)_([^_\s][^_]*)_|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/(?:[^\s<>()[\]`]|\([^\s<>()[\]`]*\))*(?:[^\s<>()[\]`.,;:!?'"]|\([^\s<>()[\]`]*\)))/;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) { out.push(rest); break; }
    if (match.index) out.push(rest.slice(0, match.index));
    const k = `${key}-${index++}`;
    if (match[1]) out.push(<code key={k}>{match[2]}</code>);
    else if (match[3] ?? match[4]) out.push(<strong key={k}>{inline(match[3] ?? match[4], k, links)}</strong>);
    else if (match[5] ?? match[6]) out.push(<em key={k}>{inline(match[5] ?? match[6], k, links)}</em>);
    else if (match[9]) out.push(links ? <ChatLink key={k} url={match[9]}>{match[9]}</ChatLink> : match[9]);
    else out.push(links ? <ChatLink key={k} url={match[8]}>{inline(match[7], k, false)}</ChatLink> : <Fragment key={k}>{inline(match[7], k, false)}</Fragment>);
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

function blocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n'); const out: ReactNode[] = []; let i = 0; let key = 0;
  const isBlockStart = (line: string) => /^(```|#{1,6}\s|>\s?|\s*([-*+]|\d+[.)])\s+|\|)/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++; out.push(<CodeBlock key={key++} code={body.join('\n')} language={fence[1] || undefined} />); continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { const Tag = `h${Math.min(6, heading[1].length + 2)}` as 'h3'; out.push(<Tag key={key++}>{inline(heading[2])}</Tag>); i++; continue; }
    if (/^>\s?/.test(line)) {
      const body: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(<blockquote key={key++}>{blocks(body.join('\n'))}</blockquote>); continue;
    }
    if (/^\|/.test(line)) {
      const rows: string[][] = []; while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i].replace(/^\||\|\s*$/g, '').split('|').map((cell) => cell.trim())); i++; }
      const body = rows.filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
      const [head, ...rest] = body;
      out.push(<div key={key++} className="chat-table"><table><thead><tr>{head?.map((cell, c) => <th key={c}>{inline(cell)}</th>)}</tr></thead><tbody>{rest.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]); const entries: { text: string; children: string[] }[] = [];
      while (i < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (next && next[1].length <= item[1].length) { entries.push({ text: next[3], children: [] }); i++; continue; }
        // Indented lines (nested lists, continued text) belong to the item above.
        if (entries.length && lines[i].trim() && /^\s+/.test(lines[i])) { entries.at(-1)!.children.push(lines[i].replace(/^\s{2,4}/, '')); i++; continue; }
        break;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(<List key={key++}>{entries.map((entry, e) => <li key={e}>{inline(entry.text)}{entry.children.length > 0 && blocks(entry.children.join('\n'))}</li>)}</List>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) paragraph.push(lines[i++]);
    if (!paragraph.length) { paragraph.push(line); i++; }
    out.push(<p key={key++}>{paragraph.map((text, p) => <Fragment key={p}>{p > 0 && <br />}{inline(text, `p${p}`)}</Fragment>)}</p>);
  }
  return out;
}
