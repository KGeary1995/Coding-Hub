import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startWindowHealth } from './runtime/window-health';
// Fonts ship with the app so it renders the same offline.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './tokens.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import '@xterm/xterm/css/xterm.css';
// One stylesheet per owner: shared pieces first, then each area's (src/styles/), in this order.
import './ui.css';
import './shell.css';
import './tile.css';
import './styles/chat.css';
import './styles/linked.css';
import './styles/start.css';
import './styles/changes.css';
import './styles/usage.css';
import './styles/tasks.css';
import './styles/setup.css';
import './styles/settings.css';
import './styles/workbench.css';

// A stall or lost GPU context in this window is recorded in host-health.json, as the main process's are.
startWindowHealth();
// Terminals measure their cell size when created, so load the terminal font first. The files are local.
const terminalFont = ['400 13px "IBM Plex Mono"', '600 13px "IBM Plex Mono"'].map((font) => document.fonts.load(font));
void Promise.allSettled(terminalFont).then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ErrorBoundary label="Trace's window"><App /></ErrorBoundary></React.StrictMode>,
));
