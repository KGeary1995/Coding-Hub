import { Fragment, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, CircleHelp, Search } from 'lucide-react';
import { HELP_TOPICS, searchHelp } from '../../shared/help-content';
import { useWorkspaceStore } from '../state/workspace-store';

/** Shortcuts written in the guide's text ("Ctrl+Shift+P", "Alt+1", "F1"), drawn as key hints. */
const KEYS = /\b((?:Ctrl|Cmd|Alt|Shift)(?:\+(?:Ctrl|Cmd|Alt|Shift))*\+[A-Z0-9]\b|F\d{1,2}\b)/;
function withKeys(text: string): ReactNode { const parts = text.split(KEYS); return parts.length === 1 ? text : parts.map((part, i) => i % 2 ? <kbd key={i}>{part}</kbd> : <Fragment key={i}>{part}</Fragment>); }

export function HelpPanel() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All topics');
  const selected = useWorkspaceStore((s) => s.helpTopicId);
  const setSelected = (helpTopicId: string) => useWorkspaceStore.setState({ helpTopicId });
  const setView = useWorkspaceStore((s) => s.setView);
  const topics = searchHelp(query, category);
  const topic = topics.find((t) => t.id === selected) ?? topics[0];
  const categories = ['All topics', ...new Set(HELP_TOPICS.map((t) => t.category))];
  const openTopic = (id: string) => { setQuery(''); setCategory('All topics'); setSelected(id); document.getElementById('main-content')?.scrollTo({ top: 0 }); /* The page scrolls in main.main-shell, not the article. */ };

  return <section className="feature-panel hub-panel workbench-page help-panel">
    <header className="ui-page-head"><span className="ui-page-icon"><CircleHelp aria-hidden="true" /></span><div><h1>Help & AI guide</h1><p>Concepts, tools and fixes, kept on this computer so they work offline.</p></div></header>
    <div className="help-search"><Search aria-hidden="true" /><input aria-label="Search help topics" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search MCP, skills, plugins, rules, tokens, setup…" /><small>{topics.length} {topics.length === 1 ? 'topic' : 'topics'}</small></div>
    <div className="help-categories" aria-label="Help categories">{categories.map((item) => <button key={item} aria-pressed={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div>
    <div className="help-workbench"><nav className="help-topics ui-list" aria-label="Help topics">{topics.length ? topics.map((t) => <button key={t.id} aria-current={t.id === topic?.id ? 'page' : undefined} className={`ui-row${t.id === topic?.id ? ' selected' : ''}`} onClick={() => setSelected(t.id)}><span className="ui-row-main"><strong>{t.title}</strong><small>{t.category}</small></span></button>) : <div className="ui-empty"><Search aria-hidden="true" /><h3>No matching topics</h3><p>Try a shorter search or choose All topics.</p><button className="button secondary" onClick={() => { setQuery(''); setCategory('All topics'); }}>Reset search</button></div>}</nav>
      <article className="help-article" aria-label="Help article">{topic ? <><header><span className="ui-badge accent">{topic.category}</span><h2>{topic.title}</h2><p className="help-summary">{topic.summary}</p></header>{topic.id === 'overview' && <div className="help-flow"><span>You</span><ArrowRight aria-hidden="true" /><span>Local CLI</span><ArrowRight aria-hidden="true" /><span>Model & tools</span><ArrowRight aria-hidden="true" /><span>Reviewed result</span></div>}{topic.id === 'extensions' && <table className="help-comparison"><thead><tr><th>Mechanism</th><th>What it provides</th></tr></thead><tbody>{[['MCP server', 'Access to tools and data'], ['Skill', 'A task-specific procedure'], ['Plugin', 'A package of extensions'], ['Shared rules', 'Persistent expectations'], ['Shared memory', 'Project facts and handoffs']].map(([name, purpose]) => <tr key={name}><td>{name}</td><td>{purpose}</td></tr>)}</tbody></table>}{topic.sections.map((section) => <section key={section.title}><h3>{section.title}</h3>{section.paragraphs.map((p) => <p key={p}>{withKeys(p)}</p>)}{section.bullets && <ul>{section.bullets.map((item) => <li key={item}>{withKeys(item)}</li>)}</ul>}{section.example && <pre>{section.example}</pre>}</section>)}<footer><span className="eyebrow">Related topics</span><div>{topic.related.map((id) => <button key={id} className="button secondary" onClick={() => openTopic(id)}>{HELP_TOPICS.find((t) => t.id === id)?.title}<ArrowRight aria-hidden="true" /></button>)}</div>{topic.id === 'rules' && <button className="button primary" onClick={() => setView('rules')}>Open Shared rules</button>}{topic.id === 'mcp' && <button className="button primary" onClick={() => setView('connectors')}>Open MCP servers</button>}{topic.id === 'memory' && <button className="button primary" onClick={() => setView('memory')}>Open Shared memory</button>}</footer></> : <div className="ui-empty"><BookOpen aria-hidden="true" /><h3>Explore the guide</h3><p>Clear the filters to browse the local AI reference.</p></div>}</article>
    </div>
  </section>;
}
