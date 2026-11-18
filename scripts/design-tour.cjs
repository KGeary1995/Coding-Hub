// Screenshots Trace in use, view by view, for judging the design: a throwaway Git project, fixture CLIs in place of Claude
// Code and Codex (no real agent starts and no tokens are spent), an isolated profile and, by default, a temporary home.
// Usage: node scripts/design-tour.cjs <outDir> [--dev] [--only=usage,settings] [--size=1440x900] [--visible] [--real-usage]
//   --dev         load the window from a running Vite server (npx vite --host 127.0.0.1, with CODING_HUB_NO_HMR=1 so an
//                 edit elsewhere does not reload the page mid-tour) instead of dist/, so no build is needed between edits
//   --only        take only the shots whose name contains one of these words (setup still runs, so they show content)
//   --size        size of the page, so of every shot (default 1440x900); without it a short list is also taken at
//                 1100x800 (-1100)
//   --visible     leave the window on screen; by default it is moved off screen so it does not cover the person's work
//   --real-usage  keep the real home folder, so Usage, Session history's native conversations and Accounts read the
//                 person's own ~/.claude and ~/.codex (and GitHub sees the real gh login): the screenshots then contain
//                 personal data (projects, usage, account names). Without it the e-mail shown is the fixture's. The
//                 Terminal channel's two commands are then also added to the person's own shell history.
//   TOUR_DEBUG=1  print the whole error of a skipped scene, not just its first line
// Shots (a view taller than the window is taken as -a, -b, … top to bottom, at most ten: Settings needs seven at 1100x800):
//   00-start (-1100, -contrast)  empty window, no project      01-workspace-idle   project opened, two channels not started
//   02-channels-running  Claude, Codex and a Terminal running  03-chat             Round Table chat: messages and an approval
//   04-tile-detail       detail row under a tile header        05-layout-single    one channel maximised
//   06/07/08-layout-columns/rows/grid                          09-needs-you        approval wait: notice and status-bar alert
//   10-needs-you-list    the Needs you list                    11-failed-channel   a channel whose CLI failed to start
//   12-close-question    Close on a running channel            13-menu-project … 16-menu-new-channel   the top-bar menus
//   17-command-menu, 18-command-menu-query                     19-changes          diff of a file, delivery column
//   20-files … 30-settings, 31-34-workflow-*, 35-ai-coaching, 36-verification-profiles, 37-more-tools, 38-help-topic
//   then 02, 19, 21, 23, 30 again with -1100 (unless --size) and -contrast (Higher contrast on)
const { realpath, mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { openView, addChannel, tileControl } = require('./lib/navigate.cjs');
const { removeFolder } = require('./lib/cleanup.cjs');
const { makeProject, installFixtures } = require('./lib/tour-project.cjs');

const flags = process.argv.slice(3);
const flag = (name) => flags.find((value) => value === `--${name}` || value.startsWith(`--${name}=`))?.split('=')[1] ?? (flags.includes(`--${name}`) ? '' : undefined);
const only = flag('only')?.split(',').map((word) => word.trim().toLowerCase()).filter(Boolean) ?? [];
const [width, height] = (flag('size') ?? '1440x900').split('x').map(Number);
const realUsage = flag('real-usage') !== undefined;
/** The letters a long view's shots end in, top to bottom. */
const PARTS = 'abcdefghij';
const VIEWS =[['20-files', 'Files'], ['21-tasks', 'Tasks'], ['22-session-history', 'Session history'], ['23-usage', 'Usage'], ['24-projects', 'Projects'],
  ['25-accounts', 'Accounts & connections'], ['26-shared-memory', 'Shared memory'], ['27-shared-rules', 'Shared rules'], ['28-mcp-servers', 'MCP servers'],
  ['29-skills-plugins', 'Skills & plugins'], ['30-settings', 'Settings'], ['35-ai-coaching', 'AI coaching'], ['36-verification-profiles', 'Verification profiles'], ['37-more-tools', 'More tools']];

(async () => {
  const started = Date.now();
  const out = path.resolve(process.argv[2] ?? 'design-tour'); await mkdir(out, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hub-tour-')));
  const project = path.join(root, 'tour-project'); const bin = path.join(root, 'bin');
  const homes = { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') };
  const storage = path.join(root, 'storage');
  const env = { ...process.env, CODING_HUB_STORAGE_DIR: storage };
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere: with both in the temp folder, no account, e-mail address,
  // history or usage of the person's shows. --real-usage keeps them; the fixtures still write only to their own folders.
  if (!realUsage) { env.USERPROFILE = env.HOME = path.join(root, 'home'); env.CLAUDE_CONFIG_DIR = homes.claude; env.CODEX_HOME = homes.codex; env.GH_CONFIG_DIR = path.join(root, 'gh'); }
  /** What the app starts with. Called inside `try`, so the temporary folder is removed when any of this fails too. */
  const prepare = async () => {
    await makeProject(project); await installFixtures(bin, homes);
    // Signed in, as far as Accounts can tell: the fixture's auth status reads these markers.
    for (const home of Object.values(homes)) { await mkdir(home, { recursive: true }); await writeFile(path.join(home, 'fixture-authenticated'), 'fixture-only'); }
    await mkdir(path.join(root, 'drive'), { recursive: true }); await mkdir(storage);
    // Trace's default Drive folder is G:\My Drive\Coding Hub: where it exists, the tour's memory notes and session summaries
    // would sync into the person's real Drive. A throwaway folder takes its place before the app starts.
    await writeFile(path.join(storage, 'preferences.json'), JSON.stringify({ folderId: 'tour', driveDirectory: path.join(root, 'drive'), terminalFontSize: 13, terminalWebGL: false, automaticMemory: true, prices: [{ model: 'fixture-model', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }] }));
    // AppData too: PowerShell finds no AppData folder in a bare home and writes its history into the project instead.
    if (!realUsage) for (const folder of ['Roaming', 'Local']) await mkdir(path.join(env.HOME, 'AppData', folder), { recursive: true });
  };
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), ...(flag('dev') === undefined ? ['--production'] : [])];
  let app; let page; let shots = 0; let skips = 0;
  const wanted = (name) => !only.length || only.some((word) => name.toLowerCase().includes(word));
  /** A shot or any of its -a … -f parts. */
  const wantedAny = (name) => [name, ...[...PARTS].map((part) => `${name}-${part}`)].some(wanted);
  /**
   * Waits for the animations that end: a waiting or failed channel's frame blinks three times (1.2 s) and a notice slides
   * in, and a shot taken meanwhile showed the frame in its off phase. Endless ones (a spinner, the working dots) run on.
   */
  const settle = () => page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {}))), new Promise((done) => setTimeout(done, 2500))]).then(() => {}));
  const shot = async (name, force = false) => { if (!force && !wanted(name)) return; await page.waitForTimeout(400); await settle(); await page.screenshot({ path: path.join(out, `${name}.png`) }); shots++; console.log('shot', name); };
  /** One scene: a failure is reported and the tour goes on, with any menu or dialog it left open closed. */
  const scene = async (name, run) => {
    try { await run(); }
    catch (error) { skips++; console.log(`skip ${name}: ${String(error.message ?? error).split('\n')[0]}`); if (process.env.TOUR_DEBUG) console.log(error.stack); for (let i = 0; i < 2; i++) await page.keyboard.press('Escape').catch(() => {}); await page.mouse.move(1, 1).catch(() => {}); }
  };
  /** A scene that only takes pictures runs when one of its shots is wanted; scenes that set up later ones always run. */
  const view = (names, run) => [names].flat().some(wantedAny) ? scene([names].flat()[0], run) : Promise.resolve();
  const tile = (channel) => page.getByRole('article', { name: new RegExp(` channel ${channel}(,|$)`) });
  const typeIn = async (channel, ...lines) => { await tile(channel).getByRole('textbox', { name: 'Terminal input' }).focus(); for (const line of lines) { await page.keyboard.type(line); await page.keyboard.press('Enter'); await page.waitForTimeout(250); } };
  // xterm's own row layer (not a Trace class): terminal text has no accessible role.
  const terminalShows = (channel, text) => tile(channel).locator('.xterm-rows').filter({ hasText: text }).waitFor();
  /**
   * Makes the page exactly w × h. Windows takes the frame (16 × 39 px) out of the size asked for while the window is on
   * a screen, and stops doing so at the first resize off screen, so the same call gave a 1424 × 861 first shot and
   * 1440 × 900 ones after the 1100 pass. The size is corrected by what the page measures, until it matches.
   */
  const setSize = async (w, h) => {
    let outer = [w, h];
    for (let attempt = 0; attempt < 4; attempt++) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), outer); await page.waitForTimeout(300);
      const inner = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      if (inner[0] === w && inner[1] === h) break;
      outer = [outer[0] + w - inner[0], outer[1] + h - inner[1]];
    }
    await page.waitForTimeout(200);
  };
  /** The largest box in the window that scrolls: the page of a long view, or its main panel. Marked for scrolling. */
  const findScroller = () => page.evaluate(() => {
    for (const old of document.querySelectorAll('[data-tour-scroll]')) old.removeAttribute('data-tour-scroll');
    const boxes = [...document.querySelectorAll('body *')].filter((element) => { const style = getComputedStyle(element); return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 24 && element.clientHeight > 200 && element.checkVisibility() && !element.closest('.xterm, article[data-status]'); });
    const largest = boxes.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    // Only a box that really moves: some report more content than they let scroll.
    if (!largest) return null; largest.scrollTop = largest.scrollHeight; const reach = largest.scrollTop; largest.scrollTop = 0; if (reach < 24) return null;
    largest.setAttribute('data-tour-scroll', ''); return { client: largest.clientHeight, full: largest.clientHeight + reach };
  });
  /** A view in full: one shot if it fits, else -a, -b, … a screen apart (with a little overlap) to the bottom, at most ten. */
  const longShot = async (name) => {
    if (!wantedAny(name)) return;
    await page.waitForTimeout(600); const box = await findScroller();
    if (!box) { await shot(name, true); return; }
    const step = Math.round(box.client * 0.9); const needed = Math.ceil((box.full - box.client) / step) + 1; const parts = Math.min(PARTS.length, needed);
    if (needed > parts) console.log(`note ${name}: ${needed} screens tall; the part between the ${parts - 1}th screen and the last is not shown`);
    for (let part = 0; part < parts; part++) {
      await page.evaluate((top) => { const element = document.querySelector('[data-tour-scroll]'); if (element) element.scrollTop = top; }, part === parts - 1 ? box.full : part * step);
      await shot(`${name}-${PARTS[part]}`);
    }
    await page.evaluate(() => { const element = document.querySelector('[data-tour-scroll]'); if (element) element.scrollTop = 0; });
  };
  const open = async (name) => { await openView(page, name); await page.mouse.move(1, 1); };
  try {
    await prepare();
    app = await _electron.launch({ executablePath: require('electron'), args, env });
    page = await app.firstWindow(); page.setDefaultTimeout(10_000);
    if (flag('visible') === undefined) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setPosition(-30000, 0));
    await setSize(width, height);
    await page.getByRole('button', { name: 'Open project', exact: true }).waitFor({ timeout: 60_000 });
    await scene('00-start', async () => {
      await shot('00-start');
      if (flag('size') === undefined && wanted('00-start-1100')) { await setSize(1100, 800); await shot('00-start-1100'); await setSize(width, height); }
      if (wanted('00-start-contrast')) { await page.evaluate(() => { document.documentElement.dataset.contrast = 'high'; }); await shot('00-start-contrast'); await page.evaluate(() => { delete document.documentElement.dataset.contrast; }); }
    });
    // The tour's own project: the folder picker answers with it, as the smoke tests do.
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await scene('01-workspace-idle', async () => { await page.getByRole('button', { name: 'Open project', exact: true }).click(); await tile(2).waitFor(); await shot('01-workspace-idle'); });

    await scene('channels', async () => {
      for (const channel of [1, 2]) await tile(channel).getByRole('button', { name: 'Start channel', exact: true }).click();
      await addChannel(page, 'Terminal');
      for (const channel of [1, 2]) await terminalShows(channel, 'READY');
      await typeIn(1, 'Add a check for an empty name to greet()', 'Then run the tests');
      await typeIn(2, 'Review src/greet.ts');
      // The shell prints its prompt after its profile loads; give it a moment before typing.
      await tile(3).getByRole('button', { name: 'Start channel', exact: true }).click(); await tile(3).getByRole('textbox', { name: 'Terminal input' }).waitFor({ timeout: 15_000 }); await page.waitForTimeout(2500);
      await typeIn(3, 'git log --oneline'); await terminalShows(3, 'Greeting library');
      await typeIn(3, 'git status --short'); await terminalShows(3, 'farewell.ts');
      await page.getByRole('button', { name: 'Arrange in grid', exact: true }).click(); await page.mouse.move(1, 1);
      await shot('02-channels-running');
    });

    await scene('03-chat', async () => {
      // A Round Table is the one + Channel entry that opens a chat: a Claude chat with Codex seated, both fixtures here.
      await page.getByRole('button', { name: 'New channel', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Round Table', exact: true }).click();
      const chat = tile(4); const box = chat.getByPlaceholder(/^Message /);
      await box.fill('What does greet() return for an empty name?', { timeout: 30_000 }); await page.keyboard.press('Enter');
      await chat.getByText('You said:', { exact: false }).first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      await box.fill('write the answer to notes.txt'); await page.keyboard.press('Enter');
      await chat.getByRole('button', { name: 'Allow', exact: true }).first().waitFor({ timeout: 20_000 });
      // Maximised, so the conversation is readable rather than a quarter of the grid.
      await (await tileControl(tile(4), 'Isolate channel 4')).click(); await page.mouse.move(1, 1);
      await shot('03-chat');
      await chat.getByRole('button', { name: 'Allow', exact: true }).first().click();
      await (await tileControl(tile(4), 'Restore grid')).click(); await page.mouse.move(1, 1);
    });

    await scene('04-tile-detail', async () => { await (await tileControl(tile(1), 'Isolate channel 1')).waitFor(); await shot('04-tile-detail'); await page.mouse.move(1, 1); });
    await scene('layouts', async () => {
      await (await tileControl(tile(1), 'Isolate channel 1')).click(); await page.mouse.move(1, 1); await shot('05-layout-single');
      await (await tileControl(tile(1), 'Restore grid')).click(); await page.mouse.move(1, 1);
      for (const [name, label] of [['06-layout-columns', 'Split vertically: columns'], ['07-layout-rows', 'Split horizontally: rows'], ['08-layout-grid', 'Arrange in grid']]) { await page.getByRole('button', { name: label, exact: true }).click(); await page.mouse.move(1, 1); await shot(name); }
    });

    await scene('09-needs-you', async () => {
      await typeIn(2, 'need-approval');
      await page.getByRole('button', { name: /^Needs you · \d+$/ }).waitFor(); await page.mouse.move(1, 1);
      await shot('09-needs-you');
      await page.getByRole('button', { name: /^Needs you · \d+$/ }).click(); await page.getByRole('dialog', { name: 'Needs you' }).waitFor();
      await shot('10-needs-you-list'); await page.keyboard.press('Escape');
      await tile(2).getByRole('button', { name: 'Answer in terminal', exact: true }).click(); await page.keyboard.type('y'); await page.keyboard.press('Enter');
    });
    await scene('11-failed-channel', async () => {
      await typeIn(1, 'fail-launch');
      await page.getByRole('button', { name: 'Retry CH1', exact: true }).first().waitFor({ timeout: 15_000 }); await page.mouse.move(1, 1);
      await shot('11-failed-channel');
      await page.getByRole('button', { name: 'Retry CH1', exact: true }).first().click(); await terminalShows(1, 'READY');
      await typeIn(1, 'Run the tests again');
    });
    await scene('12-close-question', async () => {
      await (await tileControl(tile(3), 'Close channel 3')).click();
      await tile(3).getByRole('group', { name: /^Stop .* and close channel 3\?$/ }).waitFor();
      await shot('12-close-question');
      await tile(3).getByRole('button', { name: 'Keep', exact: true }).click(); await page.mouse.move(1, 1);
    });

    for (const [name, menu] of [['13-menu-project', 'Project tour-project'], ['14-menu-insight', 'Insight views'], ['15-menu-agent-setup', 'Agent setup'], ['16-menu-new-channel', 'New channel']])
      await view(name, async () => { await page.getByRole('button', { name: menu, exact: true }).click(); await page.getByRole('menu').waitFor(); await shot(name); await page.keyboard.press('Escape'); });
    await view(['17-command-menu', '18-command-menu-query'], async () => {
      await page.getByRole('button', { name: 'Search or run a command', exact: true }).click(); await page.getByRole('dialog', { name: 'Workspace commands' }).waitFor();
      await shot('17-command-menu');
      await page.getByLabel('Search commands', { exact: true }).fill('greet'); await page.getByRole('option').first().waitFor(); await page.waitForTimeout(800);
      await shot('18-command-menu-query'); await page.keyboard.press('Escape');
    });

    await view('19-changes', async () => {
      await page.getByRole('button', { name: 'Changes', exact: true }).click();
      await page.getByRole('button', { name: 'Unstaged src/greet.ts', exact: true }).click();
      await page.getByLabel('Git diff', { exact: true }).getByText('trimmed', { exact: false }).first().waitFor();
      await longShot('19-changes');
    });
    // Content for the views that follow, made through the interface: two tasks, a handoff note and a prompt example.
    await scene('content', async () => {
      await open('Tasks');
      for (const [title, details] of [['Trim names before greeting', 'greet(" ada ") should say "Hello, Ada!". Add a test.'], ['Document farewell()', 'Add it to the README with an example.']]) {
        await page.getByRole('button', { name: 'New task', exact: true }).click();
        await page.getByLabel('Task title', { exact: true }).fill(title); await page.getByLabel('Task details', { exact: true }).fill(details);
        await page.getByRole('button', { name: 'Save to To do', exact: true }).click(); await page.getByText(title, { exact: true }).first().waitFor();
      }
      await open('Shared memory'); await page.getByText('Automatic memory key for this project', { exact: false }).waitFor();
      await page.getByLabel('Title', { exact: true }).fill('Greeting edge cases'); await page.getByLabel('Notes', { exact: true }).fill('Empty and padded names are handled in greet(); the README example still needs farewell().');
      await page.getByRole('button', { name: 'Save handoff', exact: true }).click(); await page.getByRole('heading', { name: 'Greeting edge cases', exact: true }).waitFor();
      await open('AI coaching');
      await page.getByLabel('Prompt wording', { exact: true }).fill('Fix greet() so it trims names, and add a test'); await page.getByLabel('Prompt outcome notes', { exact: true }).fill('Done in one turn');
      await page.getByRole('button', { name: 'Save prompt example', exact: true }).click();
    });
    for (const [name, label] of VIEWS) await view(name, async () => {
      await open(label);
      if (label === 'Files') { await page.getByRole('treeitem', { name: 'Folder src', exact: true }).click(); await page.getByRole('treeitem', { name: 'File src/greet.ts', exact: true }).click(); await page.getByLabel('File contents', { exact: true }).getByText('trimmed', { exact: false }).first().waitFor(); }
      if (label === 'Session history') {
        const runs = page.getByRole('list', { name: 'Recorded CLI runs' });
        // The refreshed list can put a newer run above the others: wait for it, so the pointer is not left on another run.
        await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await page.waitForTimeout(600);
        await runs.getByRole('button').filter({ hasNotText: 'running' }).first().click(); await page.getByLabel('Saved terminal output', { exact: true }).waitFor();
        // A click on a run below the fold scrolls the box that clips the list, which a person cannot do: put it back.
        await runs.evaluate((list) => { for (let box = list; box; box = box.parentElement) if (getComputedStyle(box).overflowY === 'hidden') box.scrollTop = 0; }); await page.mouse.move(1, 1);
      }
      if (label === 'Usage') { await page.getByRole('button', { name: 'Refresh', exact: true }).first().click(); await page.waitForTimeout(1000); }
      await longShot(name);
    });
    await view(['31-workflow-recovery', '32-workflow-search', '33-workflow-templates', '34-workflow-support'], async () => {
      await open('Workflow center');
      for (const [name, tab] of [['31-workflow-recovery', 'Recovery'], ['32-workflow-search', 'Search'], ['33-workflow-templates', 'Templates'], ['34-workflow-support', 'Support & releases']]) { await page.getByRole('tab', { name: tab, exact: true }).click(); await longShot(name); }
    });
    await view('38-help-topic', async () => {
      await open('Help & AI guide');
      await page.getByLabel('Search help topics', { exact: true }).fill('model context protocol');
      await page.getByRole('heading', { name: 'Model Context Protocol (MCP)', exact: true }).waitFor();
      await longShot('38-help-topic');
    });

    // The short list again: at the narrower common size, then with Higher contrast switched on in Settings.
    const SHORT = ['02-channels-running', '19-changes', '21-tasks', '23-usage', '30-settings'];
    const again = async (suffix) => {
      await view(`02-channels-running-${suffix}`, async () => { await open('Workspace'); await shot(`02-channels-running-${suffix}`); });
      await view(`19-changes-${suffix}`, async () => { await open('Changes'); await page.getByRole('button', { name: 'Unstaged src/greet.ts', exact: true }).click(); await shot(`19-changes-${suffix}`); });
      for (const [name, label] of [['21-tasks', 'Tasks'], ['23-usage', 'Usage'], ['30-settings', 'Settings']]) await view(`${name}-${suffix}`, async () => { await open(label); await shot(`${name}-${suffix}`); });
    };
    if (flag('size') === undefined && SHORT.some((name) => wanted(`${name}-1100`))) { await scene('1100', async () => { await setSize(1100, 800); await again('1100'); }); await scene('size', () => setSize(width, height)); }
    if (SHORT.some((name) => wanted(`${name}-contrast`))) await scene('contrast', async () => {
      await open('Settings'); const contrast = page.getByLabel('Higher contrast', { exact: true });
      await contrast.check(); await page.waitForFunction(() => document.documentElement.dataset.contrast === 'high');
      await again('contrast'); await open('Settings'); await page.getByLabel('Higher contrast', { exact: true }).uncheck();
    });
  } finally {
    await app?.close().catch(() => {});
    await removeFolder(root);
    console.log(`done: ${shots} shots, ${skips} skipped scenes, ${Math.round((Date.now() - started) / 1000)} s`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
