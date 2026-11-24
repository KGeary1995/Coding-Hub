import type { ChatHistoryMessage } from '../../../shared/chat';
import type { NativeSnippet } from '../../../shared/workbench';
/** Characters kept on each side of a hit (a snippet is about 160 in all), and the most snippets shown per conversation. */
const AROUND = 70; const SNIPPETS = 3;
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** On one line, so a snippet reads as a row. */
const flat = (value: string) => value.replace(/\s+/g, ' ');
/** What the person and the agent wrote: not the agent's thinking, the tools it ran or what they printed. */
export function spoken(messages: ChatHistoryMessage[]): { role: 'user' | 'assistant'; text: string }[] {
  return messages.flatMap((message): { role: 'user' | 'assistant'; text: string }[] => message.role === 'user' ? (message.text ? [{ role: 'user', text: message.text }] : []) : message.blocks.flatMap((block) => block.type === 'text' && block.text ? [{ role: 'assistant', text: block.text }] : []));
}
/**
 * Whether a raw transcript can hold `query` at all, checked before its lines are parsed (most files cannot, and parsing is
 * the slow part). The words are looked for as JSON writes them; only plain ASCII is checked, since a CLI may escape other characters.
 */
export function mayContain(raw: string, query: string): boolean {
  return !/^[\x20-\x7e]+$/.test(query) || new RegExp(escaped(JSON.stringify(query).slice(1, -1)), 'i').test(raw);
}
/** How often `query` appears in what was said, ignoring case, and where it first does in up to SNIPPETS messages. */
export function findWords(messages: ChatHistoryMessage[], query: string): { matches: number; snippets: NativeSnippet[] } {
  const pattern = new RegExp(escaped(query), 'gi'); const snippets: NativeSnippet[] = []; let matches = 0;
  for (const { role, text } of spoken(messages)) {
    let shown = false;
    for (const hit of text.matchAll(pattern)) {
      matches++; if (shown || snippets.length >= SNIPPETS) continue; shown = true;
      const start = Math.max(0, hit.index - AROUND); const end = Math.min(text.length, hit.index + hit[0].length + AROUND);
      snippets.push({ role, before: `${start > 0 ? '…' : ''}${flat(text.slice(start, hit.index)).trimStart()}`, match: flat(hit[0]), after: `${flat(text.slice(hit.index + hit[0].length, end)).trimEnd()}${end < text.length ? '…' : ''}` });
    }
  }
  return { matches, snippets };
}
