/**
 * The page a paired phone opens. Kept as plain files the remote serves itself, so it works with the strict content
 * policy (no inline script) and needs nothing from the desktop renderer build.
 */
const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1010"><title>Trace remote</title><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/app.css"></head>
<body><header><strong>trace</strong> <span id="state">remote</span></header>
<main>
  <section id="pair" hidden><h1>Pair this phone</h1><p>Enter the code shown in Trace on your computer (Settings → Phone access).</p>
    <label>Pairing code<input id="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false"></label>
    <label>Name for this phone<input id="name" maxlength="60"></label><button id="pair-button">Pair</button><p id="pair-error" role="alert"></p></section>
  <section id="channels" hidden><h1>Channels</h1><ul id="channel-list"></ul><p id="empty" hidden>No channels yet. Open a project in Trace on your computer.</p></section>
  <section id="channel" hidden>
    <div class="bar"><button id="back" aria-label="Back to channels">‹</button><strong id="channel-title"></strong></div>
    <p id="waiting" role="status" hidden></p>
    <pre id="output" aria-label="Channel output" tabindex="0"></pre>
    <div class="keys"><button data-key="y">y</button><button data-key="n">n</button><button data-key="enter">Enter</button><button data-key="escape">Esc</button><button data-key="up" aria-label="Up">↑</button><button data-key="down" aria-label="Down">↓</button><button data-key="interrupt">Ctrl C</button></div>
    <form id="send"><input id="text" aria-label="Message" autocomplete="off" placeholder="Type to the CLI"><button>Send</button></form>
    <p id="send-error" role="alert"></p>
  </section>
</main><script src="/app.js"></script></body></html>`;

const CSS = `:root{color-scheme:dark;--bg:#0b1010;--panel:#121a19;--line:#24312f;--fg:#d8e3df;--dim:#879692;--wait:#e58bd8;--fail:#ef6b55}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
header{display:flex;gap:8px;align-items:baseline;padding:12px 16px;border-bottom:1px solid var(--line)}header span{color:var(--dim);font-size:13px}
main{padding:12px 16px}h1{font-size:20px;margin:4px 0 12px}label{display:block;margin:10px 0;color:var(--dim);font-size:13px}
input{display:block;width:100%;margin-top:4px;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);font:inherit}
button{padding:10px 14px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);font:inherit}
ul{list-style:none;margin:0;padding:0}li button{width:100%;text-align:left;margin-bottom:8px;display:flex;justify-content:space-between;gap:8px}
.waiting{border-color:var(--wait)}.tag{color:var(--dim);font-size:13px}.waiting .tag{color:var(--wait)}
.bar{display:flex;gap:10px;align-items:center;margin-bottom:8px}#waiting{color:var(--wait);margin:6px 0}
pre{height:52vh;overflow:auto;margin:0;padding:10px;background:#070a0a;border:1px solid var(--line);border-radius:6px;font:12px/1.35 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
.keys{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}form{display:flex;gap:8px}form input{margin:0}[role=alert]{color:var(--fail)}`;

const JS = String.raw`(() => {
  const KEY = 'trace-remote-token'; const $ = (id) => document.getElementById(id);
  let token = localStorage.getItem(KEY); let channels = []; let current = null; let run = null; let stream = null;
  const show = (id) => { for (const section of ['pair', 'channels', 'channel']) $(section).hidden = section !== id; };
  const strip = (text) => text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '').replace(/\r(?!\n)/g, '');
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    if (response.status === 401) { localStorage.removeItem(KEY); token = null; start(); throw new Error('This phone is not paired.'); }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Request failed.');
    return response;
  };
  function renderChannels() {
    const list = $('channel-list'); list.textContent = ''; $('empty').hidden = channels.length > 0;
    for (const channel of channels) {
      const button = document.createElement('button'); if (channel.attention) button.className = 'waiting';
      const name = document.createElement('span'); name.textContent = 'CH' + channel.channel + ' · ' + channel.title;
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = channel.attention ? 'needs you' : channel.running ? 'running' : 'idle';
      button.append(name, tag); button.onclick = () => open(channel.sessionId);
      const item = document.createElement('li'); item.append(button); list.append(item);
    }
    const selected = channels.find((item) => item.sessionId === current);
    // A restarted channel is a new process: start its output afresh, as the desktop terminal does.
    if (selected && selected.runId && selected.runId !== run) { run = selected.runId; $('output').textContent = ''; }
    if (selected) { $('channel-title').textContent = 'CH' + selected.channel + ' · ' + selected.title; $('waiting').hidden = !selected.attention; $('waiting').textContent = selected.attention ? 'Waiting for you: ' + selected.attention : ''; }
  }
  function append(text) { const output = $('output'); const atEnd = output.scrollTop + output.clientHeight >= output.scrollHeight - 20; output.textContent = (output.textContent + strip(text)).slice(-200000); if (atEnd) output.scrollTop = output.scrollHeight; }
  async function listen() {
    if (stream) stream.abort(); const controller = new AbortController(); stream = controller;
    try {
      const response = await api('/api/stream' + (current ? '?sessionId=' + encodeURIComponent(current) : ''), { signal: controller.signal });
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      $('state').textContent = 'connected';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
        let end; while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = (/^event: (.*)$/m.exec(block) || [])[1]; const data = (/^data: (.*)$/m.exec(block) || [])[1]; if (!type || !data) continue;
          const message = JSON.parse(data);
          if (type === 'channels') { channels = message; renderChannels(); }
          else if (type === 'replay' && message.sessionId === current) { run = message.runId; $('output').textContent = ''; append(message.data); }
          else if (type === 'output' && message.sessionId === current && message.runId === run) append(message.data);
        }
      }
    } catch (error) { if (controller.signal.aborted) return; }
    // Without a key (the phone was removed) there is nothing to reconnect to until it pairs again.
    if (!token) { stream = null; return; }
    $('state').textContent = 'reconnecting…'; if (stream === controller) setTimeout(() => { if (stream === controller && token) listen(); }, 2000);
  }
  function open(sessionId) { current = sessionId; run = null; $('output').textContent = ''; show('channel'); renderChannels(); listen(); }
  // Input goes out one request at a time, in the order it was typed, so "y" then Enter can never arrive reversed.
  let queue = Promise.resolve();
  function send(data) {
    const channel = channels.find((item) => item.sessionId === current); $('send-error').textContent = '';
    if (!channel || !channel.runId || channel.runId !== run) { $('send-error').textContent = 'This channel is not running. Start it in Trace on your computer.'; return Promise.resolve(false); }
    if (data.length > 4096) { $('send-error').textContent = 'Messages sent from the phone can be at most 4,095 characters.'; return Promise.resolve(false); }
    const body = JSON.stringify({ sessionId: channel.sessionId, runId: run, data });
    const delivery = queue.then(() => api('/api/input', { method: 'POST', body })); queue = delivery.catch(() => {});
    return delivery.then(() => true, (error) => { $('send-error').textContent = error.message; return false; });
  }
  $('back').onclick = () => { current = null; show('channels'); listen(); };
  const KEYS = { y: 'y', n: 'n', enter: '\r', escape: '\x1b', up: '\x1b[A', down: '\x1b[B', interrupt: '\x03' };
  for (const button of document.querySelectorAll('[data-key]')) button.onclick = () => send(KEYS[button.dataset.key]);
  // The draft stays in the field until it has been delivered, and is cleared only if nothing new was typed meanwhile.
  $('send').onsubmit = async (event) => { event.preventDefault(); const text = $('text').value; if (!text) return; if (await send(text + '\r') && $('text').value === text) $('text').value = ''; };
  $('pair-button').onclick = async () => {
    $('pair-error').textContent = '';
    try {
      const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value.trim(), name: $('name').value.trim() }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Pairing failed.');
      token = body.token; localStorage.setItem(KEY, token); history.replaceState(null, '', '/'); start();
    } catch (error) { $('pair-error').textContent = error.message; }
  };
  function start() {
    const pairing = location.hash.startsWith('#pair=') ? location.hash.slice(6) : '';
    if (!token || pairing) { $('code').value = pairing; $('name').value = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone'; show('pair'); return; }
    show('channels'); listen();
  }
  start();
})();`;

const MANIFEST = JSON.stringify({ name: 'Trace remote', short_name: 'Trace', start_url: '/', display: 'standalone', background_color: '#0b1010', theme_color: '#0b1010' });

export const PHONE_FILES: Record<string, { type: string; body: string }> = {
  '/': { type: 'text/html; charset=utf-8', body: HTML },
  '/app.css': { type: 'text/css; charset=utf-8', body: CSS },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: JS },
  '/manifest.webmanifest': { type: 'application/manifest+json', body: MANIFEST },
};
