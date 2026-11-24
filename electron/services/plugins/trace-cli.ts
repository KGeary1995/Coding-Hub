// The `trace` helper a plugin's programs call (TRACE_CLI): one plugin API call, its answer printed as JSON.
//   trace channels.list
//   trace channels.send channel=2 "text=Review the diff"
//   trace notify "title=Build failed" body=…
// Values that are whole numbers or true/false are sent as such; `-` reads a JSON body from standard input instead.
const base = process.env.TRACE_API_URL ?? '';
const [op, ...pairs] = process.argv.slice(2);
async function main() {
  if (!op || op === '--help' || op === 'help') { process.stdout.write('Usage: trace <call> [name=value …]   Calls: channels.list, channels.read, channels.wait, channels.send, channels.start, channels.stop, channels.add, tasks.list, tasks.add, notify\n'); return 0; }
  if (!/^http:\/\/127\.0\.0\.1:\d+\/plugin\//.test(base)) { process.stderr.write('trace: run me from a Trace plugin (TRACE_API_URL is not set).\n'); return 2; }
  let body: Record<string, unknown> = {};
  if (pairs[0] === '-') { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk as Buffer); body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  else for (const pair of pairs) {
    const at = pair.indexOf('='); if (at < 1) { process.stderr.write(`trace: ${pair} is not name=value.\n`); return 2; }
    const value = pair.slice(at + 1); body[pair.slice(0, at)] = /^-?\d+$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
  }
  const response = await fetch(`${base}/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) { let why = text; try { why = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* As it came. */ } process.stderr.write(`trace: ${why}\n`); return 1; }
  process.stdout.write(text + '\n'); return 0;
}
main().then((code) => { process.exitCode = code; }, (error: unknown) => { process.stderr.write(`trace: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
