import { lazy, Suspense } from 'react';
const WorkflowCenter = lazy(() => import('./WorkflowCenter').then((module) => ({ default: module.WorkflowCenter })));
import { TasksPanel } from './TasksPanel';
import { VerificationPanel } from './VerificationPanel';
import { CoachingPanel } from './CoachingPanel';
import { DesignPanel } from './DesignPanel';
import { useWorkspaceStore } from '../state/workspace-store';
import { ProjectsPanel } from './ProjectsPanel';
import { AccountsPanel } from './AccountsPanel';
import { RulesPanel } from './RulesPanel';
import { HelpPanel } from './HelpPanel';
import { ConfigurationPanel, MemoryPanel, SettingsPanel } from './HubPanels';
import { UsageScreen } from './screens/UsageScreen';
import { AgentSetup } from './screens/AgentSetup';
import { SETUP_VIEWS } from './shell/Topbar';
export function FeaturePanel() {
  const view = useWorkspaceStore((s) => s.activeView);
  const panel = <Panel />;
  return SETUP_VIEWS.some((item) => item.view === view) ? <AgentSetup>{panel}</AgentSetup> : panel;
}

function Panel() {
  const view = useWorkspaceStore((s) => s.activeView);
  if (view === 'workflow') return <Suspense fallback={<p className="control-note">Opening workflow tools…</p>}><WorkflowCenter /></Suspense>;
  if (view === 'tasks') return <TasksPanel />;
  if (view === 'verification') return <VerificationPanel />;
  if (view === 'coaching') return <CoachingPanel />;
  if (view === 'design') return <DesignPanel />;
  if (view === 'projects') return <ProjectsPanel />;
  if (view === 'accounts') return <AccountsPanel />;
  if (view === 'connectors') return <ConfigurationPanel />;
  if (view === 'skills') return <ConfigurationPanel skills />;
  if (view === 'memory') return <MemoryPanel />;
  if (view === 'usage') return <UsageScreen />;
  if (view === 'rules') return <RulesPanel />;
  if (view === 'help') return <HelpPanel />;
  if (view === 'settings') return <SettingsPanel />;
  return null;
}
