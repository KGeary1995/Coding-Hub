import { useShallow } from 'zustand/react/shallow';
import { channelNameNow } from '../state/channel-names';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { channelsOf, useWorkspaceStore, type NavigationView } from '../state/workspace-store';
import { useHubStore } from '../state/hub-store';
import { ADVANCED_VIEWS, useAdvanced } from '../state/simple-mode';
import { showGettingStarted } from './GettingStarted';
import { refreshEngines, startSession, stopSession } from '../runtime/use-native-host';
import { workbench } from '../runtime/workbench';
import { COMMAND_SCOPES, matchRange, parseQuery, searchesFiles, type CommandScope } from '../runtime/command-search';
import { CHANNEL_STATES, channelState, usageFor } from '../state/channel-state';
import { VIEW_KEYS } from '../runtime/view-shortcuts';
import { jumpToChannel } from './shell/StatusBar';
import { useLinkedStore } from '../state/linked-store';
import { channelKeyHint } from './channel-key';
import { MOD_KEY } from './platform';
import type { SearchHit, SearchResults } from '../../shared/productivity';
import type { VerificationData } from '../../shared/workbench';
import type { PluginData } from '../../shared/plugins';
import { MAX_CHANNELS } from '../../shared/schemas';

type Group = 'actions' | 'channels' | 'files' | 'memory';
/** `tone` colours a channel's glyph: its state, or its engine while it works (the tr-state classes in shell.css). */
interface Item { id: string; group: Group; label: string; glyph: string; tone?: string; meta?: ReactNode; metaClass?: string; shortcut?: string; run: () => void }

const GROUP_ORDER: Group[] = ['actions', 'channels', 'files', 'memory'];
const GROUP_LABEL: Record<Group, string> = { actions: 'Actions', channels: 'Channels', files: 'Files', memory: 'Memory' };
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
  /** The verification profiles, read as the menu opens: each is an action that runs it (1.33.1). */
  const [checks, setChecks] = useState<VerificationData['profiles']>([]);
  useEffect(() => { if (open) void workbench<VerificationData>({ action: 'verification-list' }).then((data) => setChecks(data.profiles)).catch(() => setChecks([])); }, [open]);
  /** Trace plugins that are on, read as the menu opens: their actions are listed here (1.35.0). */
  const [plugins, setPlugins] = useState<PluginData['plugins']>([]);
  useEffect(() => { if (open) void workbench<PluginData>({ action: 'plugin-list' }).then((data) => setPlugins(data.plugins.filter((plugin) => plugin.enabled && !plugin.problem))).catch(() => setPlugins([])); }, [open]);
  /** The channel whose terminal had the keyboard when the menu opened: a plugin's channel actions are about it. */
  const opener = useRef<string | null>(null);
  const [input, setInput] = useState('');
  const [chosenScope, setChosenScope] = useState<CommandScope>('all');
  const [selected, setSelected] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  /** The local search stopped at its limits before it read everything, so a match may be missing. */
  const [limited, setLimited] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { sessions: all, rootDirectory, setView, arrange } = useWorkspaceStore(useShallow((s) => ({ sessions: s.sessions, rootDirectory: s.rootDirectory, setView: s.setView, arrange: s.arrange })));
  // Round Table seats start, stop and are answered with their lead's channel.
  const sessions = useMemo(() => channelsOf(all), [all]); const computers = useLinkedStore((state) => state.computers);
  const usage = useHubStore((state) => state.usage);
  const { scope, text } = parseQuery(input, chosenScope);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Ctrl+Shift+P typed into another computer's screen is that computer's.
      if (event.target instanceof Element && event.target.closest('.linked-screen')) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); opener.current = event.target instanceof Element ? event.target.closest('.session-tile')?.getAttribute('data-session') ?? null : null; setOpen((current) => !current); }
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
    setHits([]); setLimited(false);
    if (!open || !window.codingHub || !searchesFiles(scope, text)) return;
    let live = true;
    const timer = setTimeout(() => { void workbench<SearchResults>({ action: 'flow-search', query: text, directory: scope === 'memory' ? null : rootDirectory, includeOutput: false }).then((result) => { if (live) { setHits(result.hits); setLimited(result.limited); } }).catch(() => { if (live) setHits([]); }); }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [open, scope, text, rootDirectory]);
  const advanced = useAdvanced();
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
      { id: 'getting-started', label: 'Show the getting started guide', run: () => showGettingStarted() },
      { id: 'settings', label: 'Open settings', run: go('settings') },
      { id: 'tasks', label: 'Open tasks', run: go('tasks') },
      { id: 'coaching', label: 'Open AI coaching', run: go('coaching') },
      { id: 'verification', label: 'Open verification profiles', run: go('verification') },
      { id: 'search', label: 'Search local workspace', run: go('search') },
      { id: 'recovery', label: 'Recover a failed channel', run: () => { useWorkspaceStore.setState({ historyMode: 'failed' }); setView('history'); } },
      { id: 'templates', label: 'Apply a project template', run: go('projects') },
      { id: 'support', label: 'Export a diagnostic report', run: go('settings') },
      { id: 'grid', label: 'Arrange channels in grid', run: () => { setView('workspace'); arrange('grid'); } },
      // Each verification profile, run where its result shows (its confirmation still names the exact commands).
      ...checks.map((check) => ({ id: `check-${check.id}`, label: `Run verification: ${check.name}`, run: () => { useWorkspaceStore.setState({ runVerificationId: check.id }); setView('verification'); } })),
      // Each Trace plugin's actions: for the workspace always, for a channel when the menu was opened in one, for the repository on Changes.
      ...plugins.flatMap((plugin) => plugin.actions.filter((action) => action.context === 'workspace' || (action.context === 'channel' && opener.current) || (action.context === 'repository' && useWorkspaceStore.getState().activeView === 'diff' && rootDirectory))
        .map((action) => ({ id: `plugin-${plugin.id}-${action.id}`, label: `${plugin.name}: ${action.title}`, run: () => void workbench({ action: 'plugin-run', id: plugin.id, actionId: action.id, ...(action.context === 'channel' && opener.current ? { sessionId: opener.current } : {}), ...(action.context === 'repository' && rootDirectory ? { repository: rootDirectory } : {}) }).catch(() => {}) }))),
      { id: 'detect', label: 'Refresh local CLI detection', run: () => void refreshEngines() },
      // Each linked computer's tab (1.31.5), as its tab in the top bar opens it.
      ...computers.filter((computer) => computer.linked).map((computer) => ({ id: `computer-${computer.id}`, label: `Open ${computer.name}${computer.connected ? '' : ' (not connected)'}`, run: () => useWorkspaceStore.setState({ computerId: computer.id, activeView: 'computer' }) })),
      ...sessions.flatMap((session, index) => session.status === 'running'
        ? [{ id: `stop-${session.id}`, label: `Stop CH${index + 1} · ${channelNameNow(session)}`, run: () => void stopSession(session.id) }]
        : session.status !== 'starting' ? [{ id: `start-${session.id}`, label: `Start CH${index + 1} · ${channelNameNow(session)}`, run: () => { setView('workspace'); void startSession(session.id); } }] : []),
    ];
    // Simple mode: the advanced views, and running a verification profile, are left out (src/state/simple-mode.ts).
    const all: Item[] = actions.filter((action) => advanced || !(ADVANCED_VIEWS.includes(action.id as NavigationView) || action.id.startsWith('check-'))).map((action) => { const key = viewKey(action.id as NavigationView); return { ...action, group: 'actions' as const, glyph: '>', ...(key ? { shortcut: `G ${key.toUpperCase()}` } : {}) }; });
    sessions.forEach((session, index) => {
      const state = channelState(session, usageFor(session, usage)); const meta = CHANNEL_STATES[state];
      all.push({ id: `channel-${session.id}`, group: 'channels', label: `CH${index + 1} · ${channelNameNow(session)}`, glyph: meta.glyph, tone: state === 'working' ? session.config.engine : state,
        meta: state === 'waiting' ? `${meta.word} · ${session.attention?.message ?? 'approval'}` : meta.word, metaClass: state, shortcut: index < MAX_CHANNELS ? channelKeyHint(index + 1) : undefined, run: () => jumpToChannel(session.id) });
    });
    for (const hit of hits) {
      const memory = hit.kind !== 'file';
      all.push({ id: hit.id, group: memory ? 'memory' : 'files', label: hit.title, glyph: memory ? '#' : '/', meta: memory ? hit.kind : hit.location.replace(rootDirectory ?? '\0', '').replace(/^[\\/]/, ''), metaClass: hit.kind,
        run: () => { if (hit.kind === 'file') useWorkspaceStore.setState({ openFilePath: hit.location }); if (hit.kind === 'memory' && hit.noteId) useWorkspaceStore.setState({ openMemoryNote: { project: hit.location, id: hit.noteId } }); setView(hit.view); } });
    }
    // Actions and channels match on their label; search hits already matched their content.
    return all.filter((item) => (scope === 'all' || scope === item.group) && (item.group === 'files' || item.group === 'memory' || !text || matchRange(item.label, text)));
  }, [sessions, computers, usage, hits, scope, text, rootDirectory, setView, arrange, checks, plugins, advanced]);
  useEffect(() => { setSelected(0); }, [scope, text]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const run = (item: Item | undefined) => { if (!item) return; setOpen(false); item.run(); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((index) => Math.min(items.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); run(items[selected]); }
  };
  const groups = GROUP_ORDER.map((group) => ({ group, entries: items.map((item, index) => ({ item, index })).filter(({ item }) => item.group === group) })).filter(({ entries }) => entries.length);
  return <><button className="command-trigger" aria-label="Search or run a command" title={`Search or run a command (${MOD_KEY} ⇧ P)`} onClick={() => setOpen(true)}><Search className="command-trigger-icon" size={16} aria-hidden="true" /><span>Search or run a command</span><kbd aria-hidden="true">{MOD_KEY} ⇧ P</kbd></button>
    {open && <div className="command-backdrop tr-scrim" onClick={() => setOpen(false)}>
      <section ref={dialog} className="command-menu tr-command" role="dialog" aria-modal="true" aria-label="Workspace commands" onClick={(event) => event.stopPropagation()}>
        <div className="tr-command-input"><Search size={16} aria-hidden="true" />
          <input ref={field} role="combobox" aria-expanded="true" aria-controls="tr-command-results" aria-activedescendant={items[selected] ? `tr-cmd-${items[selected].id}` : undefined} aria-label="Search commands" placeholder="Search actions, channels, files and memory" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} spellCheck={false} />
          <span className="tr-command-count tnum">{items.length} {items.length === 1 ? 'result' : 'results'}</span></div>
        <div className="tr-command-scopes"><div className="tr-seg" role="group" aria-label="Search scope">{COMMAND_SCOPES.map((item) => <button key={item.id} className={scope === item.id ? 'active' : ''} aria-pressed={scope === item.id} title={item.prefix ? `Type ${item.prefix} first to search ${item.label.toLowerCase()}` : undefined} onClick={() => { setChosenScope(item.id); setInput(text); field.current?.focus(); }}>{item.label}{item.prefix && <kbd aria-hidden="true">{item.prefix}</kbd>}</button>)}</div></div>
        <div className="tr-command-results" id="tr-command-results" role="listbox" aria-label="Results" ref={list}>
          {groups.map(({ group, entries }) => <div key={group} role="group" aria-label={group}><div className="tr-command-group" aria-hidden="true">{GROUP_LABEL[group]}</div>
            {entries.map(({ item, index }) => <div key={item.id} id={`tr-cmd-${item.id}`} role="option" aria-selected={index === selected} className="tr-command-row" onMouseMove={() => setSelected(index)} onClick={() => run(item)}>
              <span className={`tr-command-glyph tr-state ${item.tone ?? ''}`} aria-hidden="true">{item.glyph}</span>
              <span className="tr-command-label"><Highlight label={item.label} text={text} /></span>
              {item.meta && <span className={`tr-command-meta ${item.metaClass ?? ''}`}>{item.meta}</span>}
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </div>)}
          </div>)}
          {limited && <p className="tr-command-empty" role="status">The search stopped before it read everything, so some files or notes may be missing. Type more, or search memory alone with #.</p>}
          {!items.length && <p className="tr-command-empty">{searchesFiles(scope, text) || scope === 'actions' || scope === 'channels' || !text ? 'No matches.' : 'Keep typing to search files and memory.'}</p>}
        </div>
        <footer className="tr-command-footer"><span><kbd>↑↓</kbd> move</span><span><kbd>⏎</kbd> run</span><span><kbd>Tab</kbd> scope</span><span><kbd>Esc</kbd> close</span></footer>
      </section>
    </div>}</>;
}
