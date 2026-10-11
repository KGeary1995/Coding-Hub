import { useState } from 'react';
import { ArrowRight, BookOpen, Search } from 'lucide-react';
import { HELP_TOPICS, searchHelp } from '../../shared/help-content';
import { useWorkspaceStore } from '../state/workspace-store';

export function HelpPanel() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All topics');
  const selected = useWorkspaceStore((s) => s.helpTopicId);
  const setSelected = (helpTopicId: string) => useWorkspaceStore.setState({ helpTopicId });
  const setView = useWorkspaceStore((s) => s.setView);
  const topics = searchHelp(query, category);
  const topic = topics.find((t) => t.id === selected) ?? topics[0];
  const categories = ['All topics', ...new Set(HELP_TOPICS.map((t) => t.category))];
  const openTopic = (id: string) => { setQuery(''); setCategory('All topics'); setSelected(id); document.querySelector('.help-article')?.scrollTo({ top: 0 }); };

  return <section className="feature-panel hub-panel help-panel">
    <div className="feature-panel-heading"><span className="eyebrow">UNDERSTAND YOUR AI WORKSPACE</span><h1><BookOpen size={28} />Help & AI guide</h1><p>Learn the concepts, choose the right tools, and get unstuck. Available locally, even offline.</p></div>
    <div className="help-search"><Search size={18} /><input aria-label="Search help topics" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search MCP, skills, plugins, rules, tokens, setup…" /><span>{topics.length} topics</span></div>
    <div className="help-categories" aria-label="Help categories">{categories.map((item) => <button key={item} aria-pressed={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div>
    <div className="help-workbench"><nav className="help-topics" aria-label="Help topics">{topics.length ? topics.map((t) => <button key={t.id} aria-current={t.id === topic?.id ? 'page' : undefined} className={t.id === topic?.id ? 'selected' : ''} onClick={() => setSelected(t.id)}><small>{t.category}</small><strong>{t.title}</strong><span>{t.summary}</span></button>) : <div className="hub-empty"><Search size={24} /><h2>No matching topics</h2><p>Try a shorter search or choose All topics.</p><button className="button secondary" onClick={() => { setQuery(''); setCategory('All topics'); }}>Reset search</button></div>}</nav>
      <article className="help-article" aria-label="Help article">{topic ? <><header><span className="eyebrow">{topic.category}</span><h2>{topic.title}</h2><p className="help-summary">{topic.summary}</p></header>{topic.id === 'overview' && <div className="help-flow"><span>You</span><ArrowRight size={16} /><span>Local CLI</span><ArrowRight size={16} /><span>Model & tools</span><ArrowRight size={16} /><span>Reviewed result</span></div>}{topic.id === 'extensions' && <table className="help-comparison"><thead><tr><th>Mechanism</th><th>What it provides</th></tr></thead><tbody>{[['MCP server', 'Access to tools and data'], ['Skill', 'A task-specific procedure'], ['Plugin', 'A package of extensions'], ['Shared rules', 'Persistent expectations'], ['Shared memory', 'Project facts and handoffs']].map(([name, purpose]) => <tr key={name}><td>{name}</td><td>{purpose}</td></tr>)}</tbody></table>}{topic.sections.map((section) => <section key={section.title}><h3>{section.title}</h3>{section.paragraphs.map((p) => <p key={p}>{p}</p>)}{section.bullets && <ul>{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>}{section.example && <pre>{section.example}</pre>}</section>)}<footer><span className="eyebrow">RELATED TOPICS</span><div>{topic.related.map((id) => <button key={id} onClick={() => openTopic(id)}>{HELP_TOPICS.find((t) => t.id === id)?.title}<ArrowRight size={13} /></button>)}</div>{topic.id === 'rules' && <button className="button primary" onClick={() => setView('rules')}>Open Shared rules</button>}{topic.id === 'mcp' && <button className="button primary" onClick={() => setView('connectors')}>Open MCP servers</button>}{topic.id === 'memory' && <button className="button primary" onClick={() => setView('memory')}>Open Shared memory</button>}</footer></> : <div className="hub-empty"><BookOpen size={26} /><h2>Explore the guide</h2><p>Clear the filters to browse the local AI reference.</p></div>}</article>
    </div>
  </section>;
}
