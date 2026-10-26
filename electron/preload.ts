import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CodingHubHost, SessionEvent } from '../shared/ipc';
import type { AccountEvent } from '../shared/accounts';
import type { UpdateStatus } from '../shared/updates';
import type { UsageRecord } from '../shared/hub';
import type { ChannelControl, LinkedComputerEvent } from '../shared/remote';

// Sandbox preloads cannot require project modules; keep the allowlisted channel literal here.
const host: CodingHubHost = {
  workbench: (request) => ipcRenderer.invoke('coding-hub:workbench', request),
  coaching: (request) => ipcRenderer.invoke('coding-hub:coaching', request),
  designs: (request) => ipcRenderer.invoke('coding-hub:designs', request),
  projects: (request) => ipcRenderer.invoke('coding-hub:projects', request),
  accounts: (request) => ipcRenderer.invoke('coding-hub:accounts', request),
  onAccountEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, value: AccountEvent) => listener(value);
    ipcRenderer.on('coding-hub:account-event', receive);
    return () => ipcRenderer.removeListener('coding-hub:account-event', receive);
  },
  projectChecks: (request) => ipcRenderer.invoke('coding-hub:project-checks', request),
  projectTools: (request) => ipcRenderer.invoke('coding-hub:project-tools', request),
  updates: (request) => ipcRenderer.invoke('coding-hub:updates', request),
  onUpdateStatus: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on('coding-hub:update-status', receive);
    return () => ipcRenderer.removeListener('coding-hub:update-status', receive);
  },
  hub: (request) => ipcRenderer.invoke('coding-hub:hub', request),
  onUsage: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, usage: UsageRecord) => listener(usage);
    ipcRenderer.on('coding-hub:usage', receive);
    return () => ipcRenderer.removeListener('coding-hub:usage', receive);
  },
  openRepository: (request) => ipcRenderer.invoke('coding-hub:open-repository', request),
  closeRepository: (request) => ipcRenderer.invoke('coding-hub:close-repository', request),
  listDirectory: (request) => ipcRenderer.invoke('coding-hub:list-directory', request),
  readFile: (request) => ipcRenderer.invoke('coding-hub:read-file', request),
  gitStatus: (request) => ipcRenderer.invoke('coding-hub:git-status', request),
  gitDiff: (request) => ipcRenderer.invoke('coding-hub:git-diff', request),
  loadWorkspace: () => ipcRenderer.invoke('coding-hub:load-workspace'),
  saveWorkspace: (workspace) => ipcRenderer.invoke('coding-hub:save-workspace', workspace),
  listHistory: () => ipcRenderer.invoke('coding-hub:list-history'),
  readRunLog: (request) => ipcRenderer.invoke('coding-hub:read-run-log', request),
  finishWorkspaceFlush: (request) => ipcRenderer.invoke('coding-hub:finish-workspace-flush', request),
  onWorkspaceFlush: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, requestId: string) => listener(requestId);
    ipcRenderer.on('coding-hub:workspace-flush', receive);
    return () => ipcRenderer.removeListener('coding-hub:workspace-flush', receive);
  },
  onStorageError: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('coding-hub:storage-error', receive);
    return () => ipcRenderer.removeListener('coding-hub:storage-error', receive);
  },
  pickDirectory: () => ipcRenderer.invoke('coding-hub:pick-directory'),
  discoverEngines: () => ipcRenderer.invoke('coding-hub:discover-engines'),
  startSession: (request) => ipcRenderer.invoke('coding-hub:start-session', request),
  writeSession: (request) => ipcRenderer.invoke('coding-hub:write-session', request),
  resizeSession: (request) => ipcRenderer.invoke('coding-hub:resize-session', request),
  stopSession: (request) => ipcRenderer.invoke('coding-hub:stop-session', request),
  onSessionEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, payload: SessionEvent) => listener(payload);
    ipcRenderer.on('coding-hub:session-event', receive);
    return () => { ipcRenderer.removeListener('coding-hub:session-event', receive); };
  },
  clipboardImage: () => ipcRenderer.invoke('coding-hub:clipboard-image'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onLinkedEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, value: LinkedComputerEvent) => listener(value);
    ipcRenderer.on('coding-hub:linked-event', receive);
    return () => ipcRenderer.removeListener('coding-hub:linked-event', receive);
  },
  onRemoteControl: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, value: { requestId: string; sessionId: string; control: ChannelControl }) => listener(value);
    ipcRenderer.on('coding-hub:remote-control', receive);
    return () => ipcRenderer.removeListener('coding-hub:remote-control', receive);
  },
  finishRemoteControl: (result) => ipcRenderer.invoke('coding-hub:finish-remote-control', result),
};
contextBridge.exposeInMainWorld('codingHub', host);
