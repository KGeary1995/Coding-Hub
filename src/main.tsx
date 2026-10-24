import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// Fonts ship with the app so it renders the same offline.
import '@fontsource/ibm-plex-sans-condensed/400.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './tokens.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './workbench.css';

// Terminals measure their cell size when created, so load the terminal font first. The files are local.
const terminalFont = ['400 13px "IBM Plex Mono"', '600 13px "IBM Plex Mono"'].map((font) => document.fonts.load(font));
void Promise.allSettled(terminalFont).then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
));
