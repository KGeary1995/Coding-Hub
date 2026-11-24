// The smoke tests' sample plugin (docs/plugins.md): each run appends one line to out.txt in its data folder.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// The tile: a program in the channel's terminal, which says it is ready and echoes each line typed into it.
if (process.argv[2] === 'tile') { process.stdout.write(`TILE READY ${process.env.TRACE_PLUGIN_ID}
`); process.stdin.on('data', (data) => process.stdout.write(`TILE GOT ${String(data).trim()}
`)); return; }
const out = path.join(process.env.TRACE_PLUGIN_DATA, 'out.txt');
const write = (line) => fs.appendFileSync(out, line + '\n');
const call = async (op, body = {}) => { const response = await fetch(`${process.env.TRACE_API_URL}/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
(async () => {
  const what = process.argv[2];
  if (what === 'list') { const { body } = await call('channels.list'); await call('notify', { title: 'Listed', body: `${body.channels.length} channels` }); write(`list ${body.channels.map((item) => `CH${item.channel}:${item.running ? 'running' : 'stopped'}`).join(',')}`); }
  // The trace helper is a .cmd on Windows, which only starts through a shell.
  else if (what === 'helper') write(`helper ${JSON.parse(execFileSync(process.env.TRACE_CLI, ['channels.list'], { encoding: 'utf8', shell: process.platform === 'win32' })).channels.length}`);
  else if (what === 'send') { const { status, body } = await call('channels.send', { channel: 1, text: 'hello' }); write(`send ${status} ${body.error ?? ''}`); }
  else if (what === 'started') write(`started CH${process.env.TRACE_CHANNEL} ${process.env.TRACE_EVENT}`);
})().catch((error) => { write(`error ${error.message}`); process.exitCode = 1; });
