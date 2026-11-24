import zlib from 'node:zlib';

/**
 * Trace's VS Code extension (1.38.0): "Send to a Trace channel" on the editor's menu sends the selected code (or the line
 * at the cursor), with its file and lines and what to do with it, to a running agent channel. It reaches Trace through
 * the editor bridge (editor-bridge.ts), whose address and key Trace writes to ~/.coding-hub/editor/connection.json, so
 * there is nothing to copy. Plain JavaScript with no dependencies; built into a .vsix when the person connects VS Code.
 */
export const EXTENSION_ID = 'trace-local.trace-vscode';

export function extensionManifest(version: string) {
  return {
    name: 'trace-vscode', publisher: 'trace-local', displayName: 'Trace', version, description: 'Send code from VS Code to a Trace channel.',
    engines: { vscode: '^1.80.0' }, main: './extension.js', categories: ['Other'], activationEvents: [],
    // Runs beside VS Code's window, so it reaches Trace on this computer even when the folder is open over SSH or in WSL.
    extensionKind: ['ui'],
    contributes: {
      commands: [{ command: 'trace.sendSelection', title: 'Send to a Trace channel', category: 'Trace' }],
      menus: { 'editor/context': [{ command: 'trace.sendSelection', group: 'navigation@90' }] },
    },
  };
}

export const EXTENSION_SOURCE = String.raw`'use strict';
const vscode = require('vscode'); const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const CONNECTION = path.join(os.homedir(), '.coding-hub', 'editor', 'connection.json');
function connection() {
  try { const value = JSON.parse(fs.readFileSync(CONNECTION, 'utf8')); if (Number.isInteger(value.port) && /^[0-9a-f]{64}$/.test(value.token)) return value; } catch (error) { /* Not connected. */ }
  return null;
}
function call(method, route, body) {
  const link = connection(); if (!link) return Promise.reject(new Error('Trace is not open. Open Trace, then try again.'));
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: link.port, method, path: '/editor/' + link.token + '/' + route, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}, timeout: 10000 }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => { let value = null; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) { /* Not JSON. */ } if (response.statusCode === 200) resolve(value); else reject(new Error((value && value.error) || 'Trace did not take it.')); });
    });
    request.on('timeout', () => request.destroy(new Error('Trace did not answer.')));
    request.on('error', (error) => reject(error && error.code === 'ECONNREFUSED' ? new Error('Trace is not open. Open Trace, then try again.') : error));
    if (data) request.write(data); request.end();
  });
}
async function send() {
  const editor = vscode.window.activeTextEditor; if (!editor) { vscode.window.showInformationMessage('Open a file and select the code to send.'); return; }
  const selection = editor.selection; const lines = selection.isEmpty ? editor.document.lineAt(selection.active.line).range : selection;
  const code = editor.document.getText(lines); if (!code.trim()) { vscode.window.showInformationMessage('Select some code to send.'); return; }
  let channels; try { channels = await call('GET', 'channels'); } catch (error) { vscode.window.showErrorMessage(error.message); return; }
  if (!channels.length) { vscode.window.showInformationMessage('No agent channel is running in Trace. Start Claude Code, Codex or Gemini there first.'); return; }
  const picked = await vscode.window.showQuickPick(channels.map((channel) => ({ label: 'CH' + channel.channel + ' · ' + channel.name, description: channel.engine + (channel.waiting ? ' · waiting for you in Trace' : ''), channel })), { placeHolder: 'Send to which channel?' });
  if (!picked) return;
  const ask = await vscode.window.showInputBox({ prompt: 'What should the agent do with it? (optional)', placeHolder: 'For example: explain this, or fix the bug here' });
  if (ask === undefined) return;
  const first = lines.start.line + 1; const last = lines.end.line + (lines.end.character === 0 && lines.end.line > lines.start.line ? 0 : 1);
  const where = editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : editor.document.uri.toString();
  const fence = code.includes('` + '```' + String.raw`') ? '~~~' : '` + '```' + String.raw`';
  const text = (ask.trim() || 'Look at this code.') + '\n\nFrom VS Code: ' + where + (first === last ? ' line ' + first : ' lines ' + first + '-' + last) + '\n' + fence + editor.document.languageId + '\n' + code.replace(/\s+$/, '') + '\n' + fence;
  try { await call('POST', 'send', { sessionId: picked.channel.sessionId, text }); vscode.window.showInformationMessage('Sent to ' + picked.label + '.'); }
  catch (error) { vscode.window.showErrorMessage(error.message); }
}
exports.activate = (context) => { context.subscriptions.push(vscode.commands.registerCommand('trace.sendSelection', send)); };
exports.deactivate = () => {};
`;

const CONTENT_TYPES = '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>';
function vsixManifest(version: string) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="trace-vscode" Version="${version}" Publisher="trace-local" />
    <DisplayName>Trace</DisplayName>
    <Description xml:space="preserve">Send code from VS Code to a Trace channel.</Description>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>`;
}

/** A zip of these files, stored without compression (all a .vsix needs). */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'); const crc = zlib.crc32(file.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(file.data.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(0, 12); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(file.data.length, 20); entry.writeUInt32LE(file.data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30); entry.writeUInt16LE(0, 32); entry.writeUInt16LE(0, 34); entry.writeUInt16LE(0, 36); entry.writeUInt32LE(0, 38); entry.writeUInt32LE(offset, 42);
    parts.push(local, name, file.data); central.push(entry, name); offset += local.length + name.length + file.data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The extension as a .vsix for `code --install-extension`. */
export function vsix(version: string): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES) },
    { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest(version)) },
    { name: 'extension/package.json', data: Buffer.from(JSON.stringify(extensionManifest(version), null, 2)) },
    { name: 'extension/extension.js', data: Buffer.from(EXTENSION_SOURCE) },
  ]);
}
