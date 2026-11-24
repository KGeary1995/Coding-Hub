/**
 * The background runner with real processes (docs/background-runner.md): Electron as Node runs the built runner, which
 * starts a real terminal through node-pty. Trace's connection is dropped while the program keeps writing; a new
 * connection lists it, reads its kept output, and stops it. With nothing left, the runner leaves by itself.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { encode, FrameReader, Kind, RUNNER_PROTOCOL } = require('../dist-electron/electron/services/runner/protocol.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-runner-smoke-'));
const address = process.platform === 'win32' ? `\\\\.\\pipe\\trace-runner-smoke-${crypto.randomBytes(6).toString('hex')}` : path.join(root, 'runner.sock');
const secret = crypto.randomBytes(32).toString('base64url'); const secretFile = path.join(root, 'secret'); fs.writeFileSync(secretFile, secret, { mode: 0o600 });
const electron = require('electron');

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address); const reader = new FrameReader(); const frames = []; const waiters = [];
    socket.on('data', (chunk) => { frames.push(...reader.push(chunk)); for (const wake of waiters.splice(0)) wake(); });
    socket.once('error', reject);
    socket.once('connect', () => {
      const next = async (kind, test = () => true, timeout = 15000) => {
        const until = Date.now() + timeout;
        for (;;) {
          const index = frames.findIndex((frame) => frame.kind === kind && test(frame));
          if (index >= 0) return frames.splice(index, 1)[0];
          if (Date.now() > until) throw new Error(`No frame of kind ${kind}`);
          await new Promise((wake) => { waiters.push(wake); setTimeout(wake, 100); });
        }
      };
      socket.write(encode(Kind.hello, 0, { version: RUNNER_PROTOCOL, secret }));
      resolve({ socket, next, frames, send: (kind, term, payload) => socket.write(encode(kind, term, payload)) });
    });
  });
}
async function retry(make, timeout = 15000) { const until = Date.now() + timeout; for (;;) { try { return await make(); } catch (error) { if (Date.now() > until) throw error; await new Promise((wake) => setTimeout(wake, 200)); } } }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const text = (frame) => frame.payload.toString('utf8');

(async () => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODING_HUB_RUNNER_ADDRESS: address, CODING_HUB_RUNNER_SECRET_FILE: secretFile };
  const runner = spawn(electron, [path.join(__dirname, '..', 'dist-electron', 'electron', 'services', 'runner', 'runner-main.js')], { env, detached: true, stdio: 'ignore', windowsHide: true });
  runner.unref();
  const first = await retry(connect); await first.next(Kind.welcome);
  // A program that writes a line every 300 ms, for about 6 seconds, then waits for input.
  const script = "let n=0;const t=setInterval(()=>{process.stdout.write('tick '+(++n)+'\\r\\n');if(n===20)clearInterval(t)},300);process.stdin.on('data',d=>{if(String(d).includes('bye'))process.exit(7)})";
  first.send(Kind.spawn, 0, { id: 'smoke-run', file: process.execPath, args: ['-e', script], cwd: root, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }, cols: 80, rows: 24 });
  const { term, pid } = JSON.parse(text(await first.next(Kind.spawned)));
  await first.next(Kind.output, (frame) => text(frame).includes('tick 1'));
  console.log('runner started a real terminal and passed its output on');

  // Trace goes away: the program keeps running and writing.
  first.socket.destroy(); await new Promise((wake) => setTimeout(wake, 2500));
  if (!alive(pid)) throw new Error('The program stopped when Trace disconnected.');
  const second = await connect(); await second.next(Kind.welcome);
  second.send(Kind.list, 0); const listed = JSON.parse(text(await second.next(Kind.list)));
  if (listed.length !== 1 || listed[0].id !== 'smoke-run' || listed[0].exitCode !== undefined) throw new Error(`Unexpected list: ${JSON.stringify(listed)}`);
  second.send(Kind.tail, term); const tail = text(await second.next(Kind.tail));
  const ticks = (tail.match(/tick \d+/g) ?? []).length;
  if (ticks < 6) throw new Error(`The kept output has only ${ticks} lines: ${JSON.stringify(tail.slice(-200))}`);
  console.log(`a new connection found it running, with ${ticks} lines kept while nobody was connected`);

  second.send(Kind.input, term, 'bye\r');
  const exited = JSON.parse(text(await second.next(Kind.exited, () => true, 20000)));
  if (exited.exitCode !== 7) throw new Error(`Exit code ${exited.exitCode}`);
  console.log('input reached the program and its exit came back');

  // Nothing left to run: once Trace leaves too, the runner goes (idle after 60 s; the smoke forgets and waits).
  second.send(Kind.forget, term); second.socket.destroy();
  const until = Date.now() + 75000; while (alive(runner.pid) && Date.now() < until) await new Promise((wake) => setTimeout(wake, 500));
  if (alive(runner.pid)) throw new Error('The runner did not leave when idle.');
  console.log('the runner left by itself when idle');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('runner smoke passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
