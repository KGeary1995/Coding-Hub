// A CLI added to Trace as a custom agent (docs/custom-agents.md), for the productivity smoke: an idle prompt ("> ") after
// each answer, a (Y)es/(N)o question when asked to "ask", and the MCP servers its --mcp-config file names.
if (process.argv.includes('--version')) { console.log('fixture-agent 1.0'); process.exit(0); }
const fs = require('node:fs');
const at = process.argv.indexOf('--mcp-config');
let servers = 'none'; if (at >= 0) try { servers = Object.keys(JSON.parse(fs.readFileSync(process.argv[at + 1], 'utf8')).mcpServers).join(',') || 'none'; } catch { servers = 'unreadable'; }
process.stdout.write(`AGENT READY MCP:${servers} ARGS:${process.argv.slice(2).filter((arg) => arg !== process.argv[at + 1]).join(' ')}\r\n> `);
process.stdin.setEncoding('utf8');
let line = '';
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      const text = line.trim(); line = '';
      if (!text) continue;
      // Answers come after a short pause, as an agent's do.
      setTimeout(() => process.stdout.write(text === 'ask' ? '\r\nEdit main.py? (Y)es/(N)o ' : `\r\nWorking on: ${text}\r\nDone: ${text}\r\n> `), 400);
    } else line += char;
  }
});
