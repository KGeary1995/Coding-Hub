import { lazy, Suspense } from 'react';
const WorkflowCenter = lazy(() => import('./WorkflowCenter').then((module) => ({ default: module.WorkflowCenter })));
import { useWorkspaceStore } from '../state/workspace-store';
// Screens load when first opened, keeping the window's start-up bundle to the workspace itself. Once the window has
// settled they are fetched in the background (preloadScreens), so opening one is still instant.
const screens = [() => import('./TasksPanel'), () => import('./VerificationPanel'), () => import('./CoachingPanel'), () => import('./DesignPanel'), () => import('./ProjectsPanel'), () => import('./AccountsPanel'), () => import('./RulesPanel'), () => import('./HelpPanel'), () => import('./HubPanels'), () => import('./screens/UsageScreen'), () => import('./WorkflowCenter')];
export function preloadScreens() { for (const load of screens) void load().catch(() => {}); }
const TasksPanel = lazy(() => import('./TasksPanel').then((module) => ({ default: module.TasksPanel })));
const VerificationPanel = lazy(() => import('./VerificationPanel').then((module) => ({ default: module.VerificationPanel })));
const CoachingPanel = lazy(() => import('./CoachingPanel').then((module) => ({ default: module.CoachingPanel })));
const DesignPanel = lazy(() => import('./DesignPanel').then((module) => ({ default: module.DesignPanel })));
const ProjectsPanel = lazy(() => import('./ProjectsPanel').then((module) => ({ default: module.ProjectsPanel })));
const AccountsPanel = lazy(() => import('./AccountsPanel').then((module) => ({ default: module.AccountsPanel })));
const RulesPanel = lazy(() => import('./RulesPanel').then((module) => ({ default: module.RulesPanel })));
const HelpPanel = lazy(() => import('./HelpPanel').then((module) => ({ default: module.HelpPanel })));
const ConfigurationPanel = lazy(() => import('./HubPanels').then((module) => ({ default: module.ConfigurationPanel })));
const MemoryPanel = lazy(() => import('./HubPanels').then((module) => ({ default: module.MemoryPanel })));
const SettingsPanel = lazy(() => import('./HubPanels').then((module) => ({ default: module.SettingsPanel })));
const UsageScreen = lazy(() => import('./screens/UsageScreen').then((module) => ({ default: module.UsageScreen })));
import { AgentSetup } from './screens/AgentSetup';
import { MORE_TOOLS, SETUP_VIEWS } from './shell/Topbar';
import { MoreTools, MoreToolsBack } from './screens/MoreTools';
export function FeaturePanel() {
  const view = useWorkspaceStore((s) => s.activeView);
  const panel = <Suspense fallback={<p className="control-note">Opening…</p>}><Panel /></Suspense>;
  if (MORE_TOOLS.some((item) => item.view === view)) return <div className="more-tools-page"><MoreToolsBack />{panel}</div>;
  return SETUP_VIEWS.some((item) => item.view === view) ? <AgentSetup>{panel}</AgentSetup> : panel;
}

function Panel() {
  const view = useWorkspaceStore((s) => s.activeView);
  if (view === 'tools') return <MoreTools />;
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
