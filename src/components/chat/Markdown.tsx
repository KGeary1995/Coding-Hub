import { Fragment, type ReactNode } from 'react';

/**
 * Claude's replies, formatted: headings, paragraphs, lists, quotes, tables, fenced code and inline code, bold, italic
 * and links. Everything becomes React elements (never HTML from the reply), so nothing in a reply can run in Trace.
 * Links show their address on hover and do not navigate the window.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="chat-markdown">{blocks(text)}</div>;
}

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []; let rest = text; let index = 0;
  const pattern = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) { out.push(rest); break; }
    if (match.index) out.push(rest.slice(0, match.index));
    const k = `${key}-${index++}`;
    if (match[1]) out.push(<code key={k}>{match[2]}</code>);
    else if (match[3] ?? match[4]) out.push(<strong key={k}>{inline(match[3] ?? match[4], k)}</strong>);
    else if (match[5] ?? match[6]) out.push(<em key={k}>{inline(match[5] ?? match[6], k)}</em>);
    else out.push(<span key={k} className="chat-link" title={match[8]}>{inline(match[7], k)}</span>);
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
      i++; out.push(<pre key={key++} className="chat-code" data-language={fence[1] || undefined}><code>{body.join('\n')}</code></pre>); continue;
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
