import { channelNameNow } from '../state/channel-names';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useWorkspaceStore, type NavigationView } from '../state/workspace-store';
import { useHubStore } from '../state/hub-store';
import { refreshEngines, startSession, stopSession } from '../runtime/use-native-host';
import { workbench } from '../runtime/workbench';
import { COMMAND_SCOPES, matchRange, parseQuery, searchesFiles, type CommandScope } from '../runtime/command-search';
import { CHANNEL_STATES, channelState, usageFor } from '../state/channel-state';
import { VIEW_KEYS } from '../runtime/view-shortcuts';
import { jumpToChannel } from './shell/StatusBar';
import type { SearchHit, SearchResults } from '../../shared/productivity';
import { MAX_CHANNELS } from '../../shared/schemas';

type Group = 'actions' | 'channels' | 'files' | 'memory';
interface Item { id: string; group: Group; label: string; glyph: string; color?: string; meta?: ReactNode; metaClass?: string; shortcut?: string; run: () => void }

const GROUP_ORDER: Group[] = ['actions', 'channels', 'files', 'memory'];
const viewKey = (view: NavigationView) => Object.entries(VIEW_KEYS).find(([, target]) => target === view)?.[0];

/** The label with the matched text in bold and underlined. */
function Highlight({ label, text }: { label: string; text: string }) {
  const range = matchRange(label, text);
  if (!range) return <>{label}</>;
  return <>{label.slice(0, range[0])}<mark>{label.slice(range[0], range[1])}</mark>{label.slice(range[1])}</>;
}

/** Ctrl ⇧ P: actions, live channels, project files and memory in one list (docs/design/trace, sheet 06). */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [chosenScope, setChosenScope] = useState<CommandScope>('all');
  const [selected, setSelected] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const field = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { sessions, rootDirectory, setView, arrange } = useWorkspaceStore();
  const usage = useHubStore((state) => state.usage);
  const { scope, text } = parseQuery(input, chosenScope);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); setOpen((current) => !current); }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    setInput(''); setChosenScope('all'); setHits([]);
    field.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      // Tab cycles the scope chips instead of leaving the dialog; Shift+Tab goes back.
      event.preventDefault();
      setChosenScope((current) => { const index = COMMAND_SCOPES.findIndex((item) => item.id === current); return COMMAND_SCOPES[(index + (event.shiftKey ? COMMAND_SCOPES.length - 1 : 1)) % COMMAND_SCOPES.length].id; });
      setInput((current) => parseQuery(current, 'all').text);
      field.current?.focus();
    };
    window.addEventListener('keydown', trapFocus);
    return () => { window.removeEventListener('keydown', trapFocus); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [open]);
  // Project files and memory come from the local search; it reads files, so it waits for a pause in typing. A memory
  // search skips the project folder, so a large project cannot use up the search's limits before the notes are read.
  // Hits from the previous query are cleared at once, so Enter cannot open one while the new search is pending.
  useEffect(() => {
    setHits([]);
    if (!open || !window.codingHub || !searchesFiles(scope, text)) return;
    let live = true;
    const timer = setTimeout(() => { void workbench<SearchResults>({ action: 'flow-search', query: text, directory: scope === 'memory' ? null : rootDirectory, includeOutput: false }).then((result) => { if (live) setHits(result.hits); }).catch(() => { if (live) setHits([]); }); }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [open, scope, text, rootDirectory]);
  const items = useMemo(() => {
    const go = (view: NavigationView) => () => setView(view);
    const actions: Omit<Item, 'group' | 'glyph'>[] = [
      { id: 'workspace', label: 'Go to workspace', run: go('workspace') },
      { id: 'projects', label: 'Open, create, or clone a project', run: go('projects') },
      { id: 'accounts', label: 'Connect Claude, Codex, or GitHub account', run: go('accounts') },
      { id: 'diff', label: 'Review Git changes', run: go('diff') },
      { id: 'history', label: 'Open session history', run: go('history') },
      { id: 'files', label: 'Browse project files', run: go('files') },
      { id: 'usage', label: 'Review token usage', run: go('usage') },
      { id: 'memory', label: 'Open shared memory', run: go('memory') },
      { id: 'rules', label: 'Edit shared rules', run: go('rules') },
      { id: 'connectors', label: 'Manage MCP servers', run: go('connectors') },
      { id: 'skills', label: 'Inspect skills and plugins', run: go('skills') },
      { id: 'help', label: 'Open help and AI guide', run: go('help') },
      { id: 'settings', label: 'Open workspace settings', run: go('settings') },
      { id: 'tools', label: 'Open more tools (design, coaching, tasks, verification)', run: go('tools') },
      { id: 'search', label: 'Search local workspace', run: () => { useWorkspaceStore.setState({ workflowTab: 'search' }); setView('workflow'); } },
      { id: 'recovery', label: 'Recover a failed session', run: () => { useWorkspaceStore.setState({ workflowTab: 'recovery' }); setView('workflow'); } },
      { id: 'templates', label: 'Apply a project template', run: () => { useWorkspaceStore.setState({ workflowTab: 'templates' }); setView('workflow'); } },
      { id: 'support', label: 'Export a diagnostic report', run: () => { useWorkspaceStore.setState({ workflowTab: 'support' }); setView('workflow'); } },
      { id: 'grid', label: 'Arrange channels in grid', run: () => { setView('workspace'); arrange('grid'); } },
      { id: 'detect', label: 'Refresh local CLI detection', run: () => void refreshEngines() },
      ...sessions.flatMap((session, index) => session.status === 'running'
        ? [{ id: `stop-${session.id}`, label: `Stop CH${index + 1} · ${channelNameNow(session)}`, run: () => void stopSession(session.id) }]
        : session.status !== 'starting' ? [{ id: `start-${session.id}`, label: `Start CH${index + 1} · ${channelNameNow(session)}`, run: () => { setView('workspace'); void startSession(session.id); } }] : []),
    ];
    const all: Item[] = actions.map((action) => { const key = viewKey(action.id as NavigationView); return { ...action, group: 'actions' as const, glyph: '>', ...(key ? { shortcut: `G ${key.toUpperCase()}` } : {}) }; });
    sessions.forEach((session, index) => {
      const state = channelState(session, usageFor(session, usage)); const meta = CHANNEL_STATES[state];
      all.push({ id: `channel-${session.id}`, group: 'channels', label: `CH${index + 1} · ${channelNameNow(session)}`, glyph: meta.glyph, color: meta.color === 'engine' ? `var(--tr-ch-${session.config.engine})` : meta.color,
        meta: state === 'waiting' ? `hold · ${session.attention?.message ?? 'approval'}` : meta.word.toLowerCase(), metaClass: state, shortcut: index < MAX_CHANNELS ? `Alt ${index + 1}` : undefined, run: () => jumpToChannel(session.id) });
    });
    for (const hit of hits) {
      const memory = hit.kind !== 'file';
      all.push({ id: hit.id, group: memory ? 'memory' : 'files', label: hit.title, glyph: memory ? '#' : '/', meta: memory ? hit.kind : hit.location.replace(rootDirectory ?? '\0', '').replace(/^[\\/]/, ''), metaClass: hit.kind,
        run: () => { if (hit.snapshotId) useWorkspaceStore.setState({ designSnapshotId: hit.snapshotId }); if (hit.kind === 'file') useWorkspaceStore.setState({ openFilePath: hit.location }); if (hit.kind === 'memory' && hit.noteId) useWorkspaceStore.setState({ openMemoryNote: { project: hit.location, id: hit.noteId } }); setView(hit.view); } });
    }
    // Actions and channels match on their label; search hits already matched their content.
    return all.filter((item) => (scope === 'all' || scope === item.group) && (item.group === 'files' || item.group === 'memory' || !text || matchRange(item.label, text)));
  }, [sessions, usage, hits, scope, text, rootDirectory, setView, arrange]);
  useEffect(() => { setSelected(0); }, [scope, text]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const run = (item: Item | undefined) => { if (!item) return; setOpen(false); item.run(); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((index) => Math.min(items.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); run(items[selected]); }
  };
  const groups = GROUP_ORDER.map((group) => ({ group, entries: items.map((item, index) => ({ item, index })).filter(({ item }) => item.group === group) })).filter(({ entries }) => entries.length);
  return <><button className="command-trigger" aria-label="Search or run a command" title="Search or run a command (Ctrl ⇧ P)" onClick={() => setOpen(true)}><Search className="command-trigger-icon" size={14} aria-hidden="true" /><span>Search or run a command</span><kbd aria-hidden="true">Ctrl ⇧ P</kbd></button>
    {open && <div className="command-backdrop tr-scrim" onClick={() => setOpen(false)}>
      <section ref={dialog} className="command-menu tr-command" role="dialog" aria-modal="true" aria-label="Workspace commands" onClick={(event) => event.stopPropagation()}>
        <div className="tr-command-input"><span aria-hidden="true">›</span>
          <input ref={field} role="combobox" aria-expanded="true" aria-controls="tr-command-results" aria-activedescendant={items[selected] ? `tr-cmd-${items[selected].id}` : undefined} aria-label="Search commands" placeholder="Search actions, channels, files and memory" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} spellCheck={false} />
          <span className="tr-command-count tnum">{items.length} {items.length === 1 ? 'result' : 'results'}</span></div>
        <div className="tr-command-scopes" role="group" aria-label="Search scope">{COMMAND_SCOPES.map((item) => <button key={item.id} className={scope === item.id ? 'active' : ''} aria-pressed={scope === item.id} title={item.prefix ? `Type ${item.prefix} first to search ${item.label.toLowerCase()}` : undefined} onClick={() => { setChosenScope(item.id); setInput(text); field.current?.focus(); }}>{item.label}{item.prefix && <kbd aria-hidden="true">{item.prefix}</kbd>}</button>)}</div>
        <div className="tr-command-results" id="tr-command-results" role="listbox" aria-label="Results" ref={list}>
          {groups.map(({ group, entries }) => <div key={group} role="group" aria-label={group}><div className="tr-command-group" aria-hidden="true">{group}</div>
            {entries.map(({ item, index }) => <div key={item.id} id={`tr-cmd-${item.id}`} role="option" aria-selected={index === selected} className="tr-command-row" onMouseMove={() => setSelected(index)} onClick={() => run(item)}>
              <span className="tr-command-glyph" style={item.color ? { color: item.color } : undefined} aria-hidden="true">{item.glyph}</span>
              <span className="tr-command-label"><Highlight label={item.label} text={text} /></span>
              {item.meta && <span className={`tr-command-meta ${item.metaClass ?? ''}`}>{item.meta}</span>}
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </div>)}
          </div>)}
          {!items.length && <p className="tr-command-empty">{searchesFiles(scope, text) || scope === 'actions' || scope === 'channels' || !text ? 'No matches.' : 'Keep typing to search files and memory.'}</p>}
        </div>
        <footer className="tr-command-footer">↑↓ move · ⏎ run · Tab scope · Esc close</footer>
      </section>
    </div>}</>;
}
