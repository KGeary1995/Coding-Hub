import { useState } from 'react';
import { CircleCheck, Circle, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { hubCall, useHubStore } from '../state/hub-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useAutoCheckStore } from '../state/auto-check-store';
import { openProjectFolder } from './shell/Topbar';
import { isAgentConfig } from '../../shared/types';
import { useGuideStore } from '../state/guide-store';

/** The guide's steps, each done once it has happened, with what does the next ones. */
export function guideSteps({ root, running, turned, checked, phoneSeen }: { root: string | null; running: boolean; turned: boolean; checked: boolean; phoneSeen: boolean }) {
  return [
    { done: Boolean(root), title: 'Open a project', text: 'The folder with your code. Agents work inside it.', action: root ? null : { label: 'Open folder', run: () => void openProjectFolder() } },
    { done: running, title: 'Start an agent', text: 'New channel, top right: Claude Code, Codex or Gemini. Each channel is one agent.', action: running ? null : { label: 'Add Claude Code', run: () => useWorkspaceStore.getState().addSession('claude') } },
    { done: turned, title: 'Ask it for something', text: 'Type in the channel what you want done and press Enter, for example “add a dark mode”.', action: null },
    { done: checked, title: 'Watch Trace check the work', text: 'After each turn that changes files, Trace runs your project’s tests and shows the result on the channel. Undo last turn puts the files back if you do not like a change.', action: null },
    { done: phoneSeen, title: 'Use it from your phone', text: 'Follow and answer your agents anywhere.', action: { label: 'Set up the phone', run: () => { useGuideStore.setState({ phoneSeen: true }); useWorkspaceStore.getState().setView('settings'); requestAnimationFrame(() => document.getElementById('settings-devices-title')?.scrollIntoView({ block: 'start' })); } } },
  ];
}

/**
 * Getting started (1.39.0): a small panel for a new person, each step ticked when it has happened (not when it was
 * read), with a button that does it. Hidden for good with its ×, or once every step is done; Help's command menu entry
 * "Show the getting started guide" brings it back.
 */
export function GettingStarted() {
  const { loaded, seen } = useHubStore(useShallow((state) => ({ loaded: state.preferencesLoaded, seen: state.preferences.guideSeen === true })));
  const { root, running, view } = useWorkspaceStore(useShallow((state) => ({ root: state.rootDirectory, running: state.sessions.some((session) => isAgentConfig(session.config) && session.status === 'running'), view: state.activeView })));
  const checked = useAutoCheckStore((state) => state.ran);
  const { turned, phoneSeen, open } = useGuideStore(); const [error, setError] = useState('');
  if (!loaded || seen || view !== 'workspace') return null;
  const hide = () => { const preferences = { ...useHubStore.getState().preferences, guideSeen: true }; void hubCall({ action: 'save-preferences', preferences }).then(() => useHubStore.getState().setPreferences(preferences), (e: Error) => setError(e.message)); };
  const steps = guideSteps({ root, running, turned, checked, phoneSeen });
  const left = steps.filter((step) => !step.done).length;
  return <aside className="getting-started" aria-label="Getting started">
    <div className="getting-started-head">
      <strong>Getting started</strong><span className="ui-hint">{left ? `${steps.length - left} of ${steps.length} done` : 'All done'}</span>
      <button type="button" className="quiet-button small icon-button" aria-label={open ? 'Fold the guide' : 'Unfold the guide'} aria-expanded={open} onClick={() => useGuideStore.setState({ open: !open })}>{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
      <button type="button" className="quiet-button small icon-button" aria-label="Hide the guide" title="Hide the guide (the command menu can show it again)" onClick={hide}><X size={14} /></button>
    </div>
    {open && <ol>{steps.map((step) => <li key={step.title} className={step.done ? 'done' : ''}>
      {step.done ? <CircleCheck size={16} aria-label="Done" /> : <Circle size={16} aria-label="Not done yet" />}
      <div><strong>{step.title}</strong><p>{step.text}</p>{step.action && !step.done && <button type="button" className="button secondary small" onClick={step.action.run}>{step.action.label}</button>}</div>
    </li>)}</ol>}
    {!left && open && <button type="button" className="button primary small" onClick={hide}>Done: hide the guide</button>}
    {error && <p className="error" role="alert">{error}</p>}
  </aside>;
}

/** Shows the guide again (the command menu's entry). */
export function showGettingStarted() {
  const preferences = { ...useHubStore.getState().preferences, guideSeen: false };
  void hubCall({ action: 'save-preferences', preferences }).then(() => { useHubStore.getState().setPreferences(preferences); useGuideStore.setState({ open: true }); useWorkspaceStore.getState().setView('workspace'); }).catch(() => {});
}
