/**
 * The background runner's process (docs/background-runner.md). Trace starts it detached from the runner kit in its
 * storage folder, never from the install folder (an update stops everything there), with ELECTRON_RUN_AS_NODE=1, the
 * pipe or socket to listen on, and the file holding the secret only this user can read.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
// Only these and node-pty are copied into the runner kit (kit.ts): nothing here may import more of Trace.
import { nodePty } from '../cli/native-pty';
import { Jobs } from './jobs';
import { Runner } from './runner';

const address = process.env.CODING_HUB_RUNNER_ADDRESS; const secretFile = process.env.CODING_HUB_RUNNER_SECRET_FILE;
if (!address || !secretFile) process.exit(2);
const log = (message: string) => { try { fs.appendFileSync(path.join(path.dirname(secretFile), 'runner.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* Nowhere to say it. */ } };
// One fault in the runner must not end every channel with it.
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? error.message}`));

const secret = fs.readFileSync(secretFile, 'utf8').trim();
// Windows: each program in a job object, so stopping a channel ends everything it started (kit: dist-electron/native).
const jobs = new Jobs(process.platform === 'win32' ? path.resolve(__dirname, '..', '..', '..', 'native', 'trace-jobs.exe') : null, log);
const server = net.createServer((socket) => runner.connect(socket));
const runner = new Runner(secret, {
  spawn: (request) => {
    const pty = nodePty().spawn(request.file, request.args, { name: 'xterm-256color', cwd: request.cwd, cols: request.cols, rows: request.rows, env: request.env });
    void jobs.add(pty.pid); pty.onExit(() => { void jobs.drop(pty.pid); }); return pty;
  },
  // Trace's own stopProcess has already ended the program's process tree by its id; the job ends whatever left that
  // tree, and then the terminal is closed.
  stop: async (pty) => { await jobs.kill(pty.pid); pty.kill(); },
  // The kit's own folder: <kit>/app/dist-electron/electron/services/runner is where this file runs.
  home: path.resolve(__dirname, '..', '..', '..', '..', '..'),
  exit: () => { jobs.close(); server.close(); if (process.platform !== 'win32') try { fs.unlinkSync(address); } catch { /* Gone already. */ } process.exit(0); },
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') { log(`listen: ${error.message}`); process.exit(1); }
  // A Windows pipe in use belongs to a runner that is alive. A Unix socket file may be left by one that is not: it is
  // replaced only when nothing answers on it.
  if (process.platform === 'win32') process.exit(0);
  const probe = net.connect(address);
  probe.once('connect', () => { probe.destroy(); process.exit(0); });
  probe.once('error', () => { try { fs.unlinkSync(address); } catch { /* Someone else did. */ } server.listen(address); });
});
server.listen(address, () => { if (process.platform !== 'win32') try { fs.chmodSync(address, 0o600); } catch { /* The folder is the user's alone too. */ } log(`listening, pid ${process.pid}`); });
