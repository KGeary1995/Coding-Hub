const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { openView, addChannel, tileControl } = require('./lib/navigate.cjs');
const { removeFolder } = require('./lib/cleanup.cjs');
const { NO_DRIVE } = require('./lib/no-drive.cjs');
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-enterprise-')));
  const bin = path.join(root, 'bin'), project = path.join(root, 'project');
  await Promise.all([bin, project].map((folder) => fs.mkdir(folder)));
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/interactive-cli.cjs'), 'utf8');
  for (const engine of ['claude', 'codex']) {
    if (process.platform === 'win32') {
      const folder = path.join(bin, 'node_modules', ...(engine === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex').split('/'));
      await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ bin: { [engine]: 'fixture.cjs' } }));
      await fs.writeFile(path.join(folder, 'fixture.cjs'), fixture); await fs.writeFile(path.join(bin, engine + '.cmd'), '@echo off\r\n');
    } else await fs.writeFile(path.join(bin, engine), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  }
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "console.log(12345)"' } }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'pipe' });
  await fs.mkdir(path.join(project, 'src')); await fs.writeFile(path.join(project, 'src/app.txt'), 'edit');
  // A repository standing in for github.com/owner/board (CODING_HUB_TEST_PLUGIN_GIT), for Install from GitHub.
  { const board = path.join(root, 'git', 'owner', 'board'); await fs.mkdir(board, { recursive: true }); const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: board, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
    await fs.writeFile(path.join(board, 'trace-plugin.json'), JSON.stringify({ id: 'fixture.board', name: 'GitHub board', version: '2.0.0', minTrace: '1.35.0', description: 'Installed from a repository', actions: [{ id: 'hello', title: 'Hello', command: ['./hello.js'] }] })); await fs.writeFile(path.join(board, 'hello.js'), '');
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'board'); }
  // And github.com/owner/agent, a shared custom agent definition for Agents → From a list.
  { const shared = path.join(root, 'git', 'owner', 'agent'); await fs.mkdir(shared, { recursive: true }); const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: shared, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
    await fs.writeFile(path.join(shared, 'trace-agent.json'), JSON.stringify({ schema: 1, id: 'shared-agent', name: 'Shared agent', program: { command: 'shared-agent' }, status: { quietSeconds: 4 } }));
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'agent'); }
  const env = { ...process.env, ...NO_DRIVE, CODING_HUB_STORAGE_DIR: path.join(root, 'storage'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), CODING_HUB_TEST_PLUGIN_GIT: path.join(root, 'git') }; delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = bin + path.delimiter + env[pathKey];
  const args = ['--user-data-dir=' + path.join(root, 'profile'), path.resolve(__dirname, '..'), '--production'];
  if (process.env.CODING_HUB_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  let app; const errors = [];
  const native = async (page, method, request) => { const result = await page.evaluate(({ method, request }) => window.codingHub[method](request), { method, request }); assert.equal(result.ok, true, result.error?.message); return result.value; };
  const wb = (page, request) => native(page, 'workbench', request);
  async function launch() {
    app = await _electron.launch({ executablePath: require('electron'), args, env }); const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForSelector('.tr-empty, .session-tile');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await page.evaluate(() => { window.events = []; window.usages = []; window.codingHub.onSessionEvent((e) => window.events.push(e)); window.codingHub.onUsage((e) => window.usages.push(e)); });
    return page;
  }
  const git = (...values) => execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...values], { cwd:project, encoding:'utf8', stdio:'pipe' }).trim();
  try {
    await fs.writeFile(path.join(project,'.gitignore'),'.env\n'); await fs.writeFile(path.join(project,'src/app.ts'),'needle source'); await fs.writeFile(path.join(project,'.env'),'needle PRIVATE_SECRET');
    git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid'); git('config','commit.gpgsign','false'); git('add','.'); git('commit','-m','Baseline');
    if (process.platform !== 'win32') await fs.writeFile(path.join(bin,'gh'), '#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);if(args[0]!=="pr"||args[1]!=="create")process.exit(1);fs.writeFileSync('+JSON.stringify(path.join(root,'pr-body.txt'))+',fs.readFileSync(args[args.indexOf("--body-file")+1],"utf8"));console.log("https://github.com/fixture/project/pull/42");', {mode:0o755});
    let page=await launch();
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},project);
    await page.getByRole('button',{name:'Open project',exact:true}).click();
    const tile=page.locator('.session-tile').nth(1);
    await (await tileControl(page, 'Engine settings for channel 2')).click();
    await tile.getByText('Channel name & budget alerts',{exact:true}).click();
    await tile.getByLabel('Channel name',{exact:true}).fill('Implementation');
    await tile.getByLabel('Channel token target',{exact:true}).fill('100');
    await tile.getByLabel('Channel context warning',{exact:true}).fill('10');
    await (await tileControl(page, 'Engine settings for channel 2')).click();
    await tile.getByRole('button',{name:'Start channel',exact:true}).click();
    await page.waitForFunction(()=>window.events.some((event)=>event.data?.includes('READY')));
    await tile.locator('.xterm-helper-textarea').focus();await page.keyboard.type('needle task');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.budget-notice').length===1);
    // An event hook (1.33.1), added in Settings once confirmed, runs when a channel needs you, told which and why.
    const hookOut=path.join(root,'hook.txt');
    await openView(page,'Settings');await page.getByLabel('Event hook event',{exact:true}).selectOption('needs-you');await page.getByLabel('Event hook program',{exact:true}).fill(process.execPath);
    await page.getByLabel('Event hook arguments',{exact:true}).fill(['-e',`require('fs').writeFileSync(${JSON.stringify(hookOut)}, [process.env.TRACE_EVENT, process.env.TRACE_CHANNEL, process.env.TRACE_MESSAGE].join('|'))`].join('\n'));
    await page.getByRole('button',{name:'Add event hook',exact:true}).click();await page.locator('.event-hooks li').first().waitFor();
    await openView(page,'Workspace');await tile.locator('.xterm-helper-textarea').focus();await page.keyboard.type('need-approval');await page.keyboard.press('Enter');
    for(let i=0;i<150&&!(await fs.stat(hookOut).catch(()=>null));i++)await new Promise((resolve)=>setTimeout(resolve,100));
    assert.match(await fs.readFile(hookOut,'utf8'),/^needs-you\|2\|Approval requested: npm test$/);
    // A Trace plugin (1.35.0): linked from a folder once confirmed, its actions run from the command menu and call Trace's
    // plugin API, within the permissions it declared; turned off, its actions are gone.
    const sample=path.resolve(__dirname,'fixtures/plugins/sample');
    const pluginOutput=async()=>{for(const file of await fs.readdir(path.join(root,'storage'),{recursive:true}))if(String(file).endsWith(path.join('fixture.sample','data','out.txt')))return fs.readFile(path.join(root,'storage',String(file)),'utf8');return '';};
    const pluginSays=async(pattern)=>{for(let i=0;i<150&&!pattern.test(await pluginOutput());i++)await new Promise((resolve)=>setTimeout(resolve,100));assert.match(await pluginOutput(),pattern);};
    const runPluginAction=async(title)=>{await page.keyboard.press('Control+Shift+P');await page.getByLabel('Search commands',{exact:true}).fill('Sample plugin');await page.getByRole('option').filter({hasText:`Sample plugin: ${title}`}).first().click();};
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},sample);
    await openView(page,'Skills & plugins');await page.getByRole('button',{name:'Link a folder',exact:true}).click();await page.locator('.trace-plugin').filter({hasText:'Sample plugin'}).waitFor();
    await runPluginAction('List channels');await pluginSays(/^list CH1:\w+,CH2:running/m);
    await runPluginAction('List channels with the trace helper');await pluginSays(/^helper \d+$/m);
    await runPluginAction('Try to message CH1');await pluginSays(/^send 409 Sample plugin did not ask for channels\.send/m);
    await page.getByLabel('Sample plugin on',{exact:true}).uncheck();await page.keyboard.press('Control+Shift+P');await page.getByLabel('Search commands',{exact:true}).fill('Sample plugin');
    await page.waitForTimeout(500);assert.equal(await page.getByRole('option').filter({hasText:'Sample plugin:'}).count(),0,'a plugin turned off has no actions');await page.keyboard.press('Escape');
    await page.getByLabel('Sample plugin on',{exact:true}).check();await openView(page,'Workspace');
    // A plugin tile (+ Channel): a channel running the plugin's tile program, found by Trace in the installed manifest.
    await page.getByRole('button',{name:'New channel',exact:true}).click();await page.getByRole('menuitem',{name:'Sample board (Sample plugin)',exact:true}).click();
    const board=page.locator('.session-tile').filter({hasText:'Sample board'});await board.getByRole('button',{name:'Start channel',exact:true}).click();
    await board.locator('.xterm-rows').filter({hasText:'TILE READY fixture.sample'}).waitFor();await board.locator('.xterm-helper-textarea').focus();await page.keyboard.type('hi board');await page.keyboard.press('Enter');await board.locator('.xterm-rows').filter({hasText:'TILE GOT hi board'}).waitFor();
    await (await tileControl(board,'Stop')).click();await page.waitForFunction(()=>![...document.querySelectorAll('.session-tile')].some((tile)=>tile.textContent.includes('Sample board')&&tile.getAttribute('data-status')==='running'));
    await (await tileControl(board,'Close channel 3')).click();await board.waitFor({state:'detached'});
    // A custom agent (1.40.0, docs/custom-agents.md): saved through the host (its system dialog is answered above), tested,
    // listed on the Agents page, added from + Channel, given shared memory through its --mcp-config file, and read for Needs
    // you (a waiting pattern) and Done (its ready prompt) from its screen.
    const agentProgram=path.resolve(__dirname,'fixtures/custom-agent.cjs');
    await wb(page,{action:'agent-save',definition:{schema:1,id:'fixture-agent',name:'Fixture agent',color:'#5ec4a8',program:{command:agentProgram,args:['--plain']},version:{args:['--version']},status:{waiting:['\\(Y\\)es/\\(N\\)o'],turnEnd:['^> $']},mcp:{format:'claude-json',args:['--mcp-config','{file}']},resume:{args:['--resume','{id}'],listArgs:['--list']}}});
    assert.match((await wb(page,{action:'agent-test',definition:(await wb(page,{action:'agent-list'})).agents[0].definition})).output,/fixture-agent 1\.0/);
    // From a list: a shared definition is fetched and checked for the form, and nothing is saved until Save confirms it.
    { const fetched=await wb(page,{action:'agent-fetch',repo:'owner/agent'}); assert.deepEqual([fetched.definition.id,fetched.problems,fetched.source.repo],['shared-agent',[],'owner/agent']); assert.deepEqual((await wb(page,{action:'agent-list'})).agents.map((agent)=>agent.id),['fixture-agent']); }
    // Its conversations to continue, as its resume.listArgs prints them (phase 2): IDs only, a header left out.
    assert.deepEqual((await wb(page,{action:'agent-conversations',id:'fixture-agent'})).map((item)=>item.id),['conv-1','conv-2']);
    await openView(page,'Agents');await page.locator('.agents-panel .ui-row').filter({hasText:'Fixture agent'}).filter({hasText:'On'}).waitFor();await openView(page,'Workspace');
    await addChannel(page,'Fixture agent');const agentTile=page.locator('.session-tile').filter({hasText:'Fixture agent'});await agentTile.getByRole('button',{name:'Start channel',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.session-tile')].some((tile)=>tile.textContent.includes('Fixture agent')&&(tile.querySelector('.xterm-rows')?.textContent.includes('AGENT READY')||tile.querySelector('.session-error'))));
    { const screen=await agentTile.locator('.xterm-rows').textContent(); const failed=await agentTile.locator('.session-error').allTextContents(); assert.match(screen,/AGENT READY MCP:coding-hub-memory(,trace-channels)? ARGS:--plain --mcp-config/,`custom agent start: ${screen} ${failed.join(' ')}`); }
    const agentSession=await agentTile.getAttribute('data-session');
    await agentTile.locator('.xterm-helper-textarea').focus();await page.keyboard.type('fix the tests');await page.keyboard.press('Enter');
    await page.waitForFunction((id)=>window.events.some((event)=>event.sessionId===id&&event.type==='answered'&&event.finished),agentSession);
    await page.keyboard.type('ask');await page.keyboard.press('Enter');
    await page.waitForFunction((id)=>window.events.some((event)=>event.sessionId===id&&event.type==='attention'&&event.message.includes('(Y)es/(N)o')),agentSession);
    await (await tileControl(agentTile,'Stop')).click();await page.waitForFunction((id)=>!document.querySelector(`.session-tile[data-session="${id}"][data-status="running"]`),agentSession);
    await (await tileControl(agentTile,'Close channel 3')).click();await agentTile.waitFor({state:'detached'});
    // Phase 2: a custom agent that speaks ACP (scripts/fixtures/acp-agent.cjs) as a chat from + Channel, given Trace's MCP
    // servers in its protocol and run in its definition's mode for Allow edits; then a Round Table of two of its chats.
    await wb(page,{action:'agent-save',definition:{schema:1,id:'fixture-acp',name:'Fixture ACP',program:{command:path.resolve(__dirname,'fixtures/acp-agent.cjs')},version:{args:['--version']},acp:{args:[],modes:{ask:'read-only',edits:'edits',full:'yolo'}}}});
    await openView(page,'Agents');await page.locator('.agents-panel .ui-row').filter({hasText:'Fixture ACP'}).filter({hasText:'On'}).waitFor();await openView(page,'Workspace');
    await addChannel(page,'Fixture ACP chat');const acpSession=await page.locator('.session-tile').filter({hasText:'Fixture ACP chat'}).getAttribute('data-session');const acpTile=page.locator(`.session-tile[data-session="${acpSession}"]`);await acpTile.getByRole('button',{name:'Start channel',exact:true}).click();
    const acpBox=acpTile.getByRole('textbox',{name:'Message to Fixture ACP',exact:true});await page.waitForFunction(()=>[...document.querySelectorAll('.session-tile textarea')].some((box)=>box.getAttribute('aria-label')==='Message to Fixture ACP'&&!box.disabled));
    await acpBox.fill('hello acp');await acpBox.press('Enter');
    await acpTile.locator('.chat-message.assistant').filter({hasText:/ACP edits fx-small got: hello acp \(mcp: coding-hub-memory/}).waitFor();
    await acpTile.getByRole('button',{name:'Round Table: add agents',exact:true}).click();const acpSetup=page.locator('dialog.table-setup');await acpSetup.waitFor();
    await acpSetup.getByLabel('Seat 2 agent',{exact:true}).selectOption('custom:fixture-acp');assert.equal(await acpSetup.getByLabel('Seat 2 name',{exact:true}).getAttribute('placeholder'),'Fixture ACP 2');
    await acpSetup.getByRole('button',{name:'Start Round Table',exact:true}).click();await acpSetup.waitFor({state:'detached',timeout:60000});
    await acpTile.locator('.table-roles').filter({hasText:'Fixture ACP drives · Fixture ACP 2 reviews'}).waitFor({state:'attached',timeout:60000});
    const tableBox=acpTile.getByRole('textbox',{name:'Message to the Round Table',exact:true});await tableBox.fill('Hello table');await tableBox.press('Enter');
    // Both answer read-only while they discuss, agree, and the driver then carries it out in its edits mode.
    await acpTile.locator('.chat-message.assistant').filter({has:page.locator('.chat-author',{hasText:'Fixture ACP 2'})}).filter({hasText:'ACP read-only fx-small got'}).first().waitFor({timeout:60000});
    await acpTile.locator('.table-status').filter({hasText:'They agree. Your turn'}).waitFor({state:'attached',timeout:60000});
    assert.ok((await acpTile.locator('.chat-message.assistant').allTextContents()).some((text)=>/ACP edits fx-small got: .*carry out/i.test(text)),'the driver carried it out in its edits mode');
    await acpTile.getByRole('button',{name:'Close the Round Table',exact:true}).click();
    await acpTile.locator('.table-bar').waitFor({state:'detached',timeout:30000});
    await (await tileControl(acpTile,'Stop')).click();await page.waitForFunction((id)=>!document.querySelector(`.session-tile[data-session="${id}"][data-status="running"]`),acpSession);
    await (await tileControl(acpTile,'Close channel 3')).click();await acpTile.waitFor({state:'detached'});
    // Install from GitHub: a preview of everything it would run, then Install (the system dialog is answered above).
    await openView(page,'Skills & plugins');await page.getByLabel('GitHub repository',{exact:true}).fill('owner/board');await page.getByRole('button',{name:'Preview',exact:true}).click();
    const preview=page.getByRole('region',{name:'Preview of GitHub board'});await preview.waitFor();assert.match(await preview.textContent(),/Action: Hello: .*hello\.js[\s\S]*nobody has reviewed it|nobody has reviewed it[\s\S]*Action: Hello: .*hello\.js/);
    await preview.getByRole('button',{name:'Install',exact:true}).click();await page.locator('.trace-plugin').filter({hasText:'GitHub board'}).filter({hasText:'GitHub: owner/board'}).waitFor();await preview.waitFor({state:'detached'});
    await openView(page,'Workspace');
    const usage=await page.evaluate(()=>window.usages.at(-1));assert.ok(usage.conversationId);
    await (await tileControl(tile, 'Stop')).click();await page.waitForFunction(()=>document.querySelectorAll('.session-tile[data-status="running"]').length===0);
    const saved=await native(page,'loadWorkspace');assert.equal(saved.workspace.sessions[1].config.resumeId,usage.conversationId);assert.equal(saved.workspace.sessions[1].title,'Implementation');
    await openView(page, 'Session history');await page.getByRole('button',{name:'View native CLI conversations',exact:true}).click();
    await page.getByText('Name and pin conversation',{exact:true}).click();await page.getByLabel('Conversation name',{exact:true}).fill('Pinned implementation');await page.getByLabel('Pin conversation',{exact:true}).check();await page.getByRole('button',{name:'Save conversation preferences',exact:true}).click();
    await page.getByRole('heading',{name:'★ Pinned implementation',exact:true}).waitFor();
    const labels=await wb(page,{action:'flow-conversations'});assert.equal(labels[0].pinned,true);
    await page.getByRole('button',{name:'Resume in new channel',exact:true}).click();await page.locator('.session-tile').nth(2).waitFor();
    await openView(page, 'AI coaching');await page.getByRole('button',{name:'Review coaching report',exact:true}).click();await page.getByLabel('Approve sharing coaching report through my CLI',{exact:true}).check();await page.getByRole('button',{name:'Prepare Claude coaching',exact:true}).click();await page.locator('.session-tile').nth(3).waitFor();
    // A channel running when Trace closes starts again by itself, on its conversation (1.32.0); the stopped ones stay stopped.
    await (await tileControl(tile,'Restart')).click();await page.waitForFunction(()=>document.querySelectorAll('.session-tile[data-status="running"]').length===1);
    // The sample plugin hears the channel start (channel.started), told which channel.
    await pluginSays(/^started CH2 channel\.started$/m);
    await app.close();app=null;page=await launch();
    // Trace starts the channel again as it opens, which can be before this page listens for output (launch() subscribes once
    // the tiles show): its run's saved output is read instead, so the check does not depend on that race.
    for (let attempt=0;;attempt++) { const running=(await native(page,'listHistory')).filter((run)=>run.status==='running'); let resumed=false; for (const run of running) if ((await native(page,'readRunLog',{runId:run.runId})).text.includes('RESUMING:')) resumed=true; if (resumed) break; assert.ok(attempt<100,'The channel running when Trace closed did not start again on its conversation'); await page.waitForTimeout(200); }
    await page.getByText('A channel running when Trace closed was started again on its conversations.',{exact:false}).waitFor();
    assert.equal(await page.locator('.session-tile[data-status="running"]').count(),1,'only the channel that was running starts again');
    await (await tileControl(page.locator('.session-tile').nth(1),'Stop')).click();await page.waitForFunction(()=>document.querySelectorAll('.session-tile[data-status="running"]').length===0);
    await page.evaluate(()=>{window.events.length=0;});
    let restored=await native(page,'loadWorkspace');assert.equal(restored.workspace.sessions[1].config.resumeId,usage.conversationId);assert.equal(restored.workspace.sessions[3].preparedRequest.label,'Send coaching request');assert.equal((await wb(page,{action:'flow-conversations'}))[0].name,'Pinned implementation');
    const resumedTile=page.locator('.session-tile').nth(1);await (await tileControl(resumedTile,'Restart')).click();await page.waitForFunction(()=>window.events.some((event)=>event.data?.includes('RESUMING:')));
    await resumedTile.locator('.xterm-helper-textarea').focus();await page.keyboard.type('fail-launch');await page.keyboard.press('Enter');await page.waitForFunction(()=>[...document.querySelectorAll('.session-error')].some((element)=>element.textContent.includes('fixture invalid model')));
    // Open log goes to Session history's Failed runs (1.31; before, the Workflow center's Recovery).
    await page.getByRole('button',{name:'Open log',exact:true}).click();await page.getByRole('heading',{name:'Failed runs',exact:true}).waitFor();await page.getByRole('button',{name:'Run recovery checks',exact:true}).click();await page.getByText('Interactive terminal transport · passed',{exact:true}).waitFor();assert.ok((await wb(page,{action:'flow-failures'})).some((run)=>run.diagnostic.includes('fixture invalid model')));
    const rules=await native(page,'hub',{action:'rules-read',directories:[project]});await native(page,'hub',{action:'rules-save',content:'needle rules: verify changes before delivery.',revision:rules.revision,targets:rules.targets.map(({directory,claudeHash,codexHash})=>({directory,claudeHash,codexHash}))});
    await native(page,'hub',{action:'memory-write',project:'demo',title:'Needle handoff',content:'needle memory',author:'human'});
    // Ctrl+Shift+F opens Search, a page of its own (1.31).
    await page.keyboard.press('Control+Shift+F');await page.getByRole('heading',{name:'Search',exact:true}).waitFor();await page.getByLabel('Workspace search query',{exact:true}).fill('needle');await page.getByRole('button',{name:'Search local workspace',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.search-results article').length>=3);
    const search=await wb(page,{action:'flow-search',query:'needle',directory:project,includeOutput:false});assert.ok(['file','memory','rules'].every((kind)=>search.hits.some((hit)=>hit.kind===kind)));assert.ok(!JSON.stringify(search).includes('PRIVATE_SECRET'));assert.ok(!search.hits.some((hit)=>hit.kind==='output'));
    const outputSearch=await wb(page,{action:'flow-search',query:'needle task',directory:null,includeOutput:true});assert.ok(outputSearch.hits.some((hit)=>hit.kind==='output'));
    await fs.writeFile(path.join(project,'src/app.ts'),'needle revised source');const initial=await wb(page,{action:'flow-git-inspect',directory:project});await wb(page,{action:'flow-git-stage',directory:project,revision:initial.revision,paths:['src/app.ts','CLAUDE.md','AGENTS.md']});const staged=await wb(page,{action:'flow-git-inspect',directory:project});assert.equal(staged.staged.length,3);await wb(page,{action:'flow-git-commit',directory:project,revision:staged.revision,message:'Reviewed implementation'});
    const remote=path.join(root,'remote.git');await fs.mkdir(remote);execFileSync('git',['init','--bare',remote],{stdio:'pipe'});git('remote','add','origin',remote);const committed=await wb(page,{action:'flow-git-inspect',directory:project});await wb(page,{action:'flow-git-push',directory:project,revision:committed.revision,remote:'origin'});assert.equal(execFileSync('git',['--git-dir',remote,'rev-parse','main'],{encoding:'utf8'}).trim(),git('rev-parse','HEAD'));
    if(process.platform!=='win32'){const current=await wb(page,{action:'flow-git-inspect',directory:project});const result=await wb(page,{action:'flow-git-pr',directory:project,revision:current.revision,title:'Fixture review',body:'Summary\n\nValidation: fixture checks pass.',base:'main',draft:true});assert.equal(result.url,'https://github.com/fixture/project/pull/42');assert.equal(await fs.readFile(path.join(root,'pr-body.txt'),'utf8'),'Summary\n\nValidation: fixture checks pass.');}
    // Changes (1.31.3): pushed, Ship's Push step is done; the file list stages and unstages a file itself, and Ship
    // has no second list. Split shows the diff side by side.
    await fs.writeFile(path.join(project,'src/app.ts'),'needle staged from the list');await openView(page,'Changes');
    const ship=page.getByRole('complementary',{name:'Git delivery',exact:true});await ship.locator('.tr-step.done').filter({hasText:'Push'}).filter({hasText:'up to date'}).waitFor();assert.equal(await ship.locator('input[type="checkbox"]').count(),1,'Ship has no list of files to tick (only Create as a draft)');
    await page.getByRole('button',{name:'Stage src/app.ts',exact:true}).click();await page.getByRole('button',{name:'Staged src/app.ts',exact:true}).waitFor();
    await page.getByRole('button',{name:'Staged src/app.ts',exact:true}).click();await page.getByRole('button',{name:'Split',exact:true}).click();await page.locator('.diff-code.split .diff-pair').first().waitFor();
    await page.getByRole('button',{name:'Unstage src/app.ts',exact:true}).click();await page.getByRole('button',{name:'Unstaged src/app.ts',exact:true}).waitFor();
    await fs.writeFile(path.join(project,'src/app.ts'),'needle revised source');
    await wb(page,{action:'verification-save',name:'Template check',directory:project,steps:[{label:'Check',tool:'npm',args:['run','check']}],timeoutSeconds:15});
    await openView(page, 'Projects');await page.getByRole('heading',{name:'Project templates',exact:true}).waitFor();await page.getByText('Save the current workspace as a template',{exact:true}).click();await page.getByLabel('Template name',{exact:true}).fill('Paired implementation');await page.getByRole('button',{name:'Save project template',exact:true}).click();await page.getByRole('heading',{name:'Paired implementation',exact:true}).waitFor();
    const templates=await wb(page,{action:'flow-templates'});assert.equal(templates[0].checks.length,1);assert.ok(templates[0].workspace.sessions.every((session)=>!session.config.resumeId&&!session.preparedRequest));
    const target=path.join(root,'new-project');await fs.mkdir(target);await page.getByRole('button',{name:'Use template',exact:true}).click();await page.getByLabel('Template target folder',{exact:true}).fill(target);await page.getByRole('button',{name:'Review and apply template',exact:true}).click();await page.waitForSelector('.tr-empty, .session-tile');restored=await native(page,'loadWorkspace');assert.equal(restored.workspace.rootDirectory,target);assert.equal(restored.workspace.sessions[1].budget.tokens,100);assert.ok((await wb(page,{action:'verification-list'})).profiles.some((item)=>item.directory===target));assert.ok((await fs.readFile(path.join(target,'CLAUDE.md'),'utf8')).includes('needle rules'));
    // A verification profile is edited in place (1.31.5; before, only copied to a new one).
    await openView(page,'Verification profiles');const profileCount=(await wb(page,{action:'verification-list'})).profiles.length;const card=page.locator('.verification-profile').filter({hasText:'Template check'}).first();await card.getByRole('button',{name:'Edit',exact:true}).click();
    await page.getByRole('heading',{name:'Editing Template check',exact:true}).waitFor();await page.getByLabel('Verification profile name',{exact:true}).fill('Template check, edited');await page.getByRole('button',{name:'Save verification profile',exact:true}).click();
    await page.locator('.verification-profile').filter({hasText:'Template check, edited'}).first().waitFor();assert.equal((await wb(page,{action:'verification-list'})).profiles.length,profileCount,'editing saves over the profile, not beside it');
    // It runs from the command menu too (1.33.1), on its page, after its confirmation.
    const resultsBefore=(await wb(page,{action:'verification-list'})).results.length;
    await page.keyboard.press('Control+Shift+P');await page.getByLabel('Search commands',{exact:true}).fill('Run verification');await page.getByRole('option').filter({hasText:'Run verification: Template check, edited'}).first().click();
    for(let i=0;i<300&&(await wb(page,{action:'verification-list'})).results.length===resultsBefore;i++)await new Promise((resolve)=>setTimeout(resolve,100));
    assert.equal((await wb(page,{action:'verification-list'})).results.length,resultsBefore+1,'the command menu ran the profile');
    // And deleted (1.31.7), after a confirmation; recorded results stay.
    const edited=page.locator('.verification-profile').filter({hasText:'Template check, edited'}).first();await edited.getByRole('button',{name:'Delete Template check, edited',exact:true}).click();await page.getByRole('button',{name:'Delete profile',exact:true}).click();await edited.waitFor({state:'detached'});assert.equal((await wb(page,{action:'verification-list'})).profiles.length,profileCount-1);
    await openView(page, 'Settings');await page.getByRole('button',{name:'Check running executable signature',exact:true}).click();await page.getByText('Source edition — no installer signature',{exact:true}).waitFor();
    const reportFile=path.join(root,'report.json');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({filePath:file,canceled:false});},reportFile);await page.getByRole('button',{name:'Export diagnostic report',exact:true}).click();await page.getByText('Diagnostic report exported.',{exact:true}).waitFor();const report=JSON.parse(await fs.readFile(reportFile,'utf8'));assert.equal(report.appVersion,require('../package.json').version);assert.ok(report.excludes.includes('Credentials'));assert.ok(!JSON.stringify(report).includes('PRIVATE_SECRET'));
    if(process.env.CODING_HUB_PRODUCTIVITY_SCREENSHOT)await page.screenshot({path:process.env.CODING_HUB_PRODUCTIVITY_SCREENSHOT});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(900,640));await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);assert.equal(await page.getByRole('button',{name:'Export diagnostic report',exact:true}).isVisible(),true);
    // Failed runs in a narrow window too: no sideways scroll.
    await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await openView(page,'Session history');await page.getByRole('button',{name:'Failed runs',exact:true}).click();await page.getByRole('button',{name:'Run recovery checks',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.body.scrollWidth>innerWidth),false);
    const backup=await wb(page,{action:'backup-create',includeLogs:true});const restoredBackup=await wb(page,{action:'backup-restore',id:backup.record.id});await app.close();app=null;page=await launch();assert.equal((await wb(page,{action:'runtime'})).storagePath,restoredBackup.restoredPath);assert.equal((await wb(page,{action:'flow-conversations'}))[0].pinned,true);assert.equal((await wb(page,{action:'flow-templates'}))[0].name,'Paired implementation');
    assert.deepEqual(errors,[]);console.log('PASS: a custom agent saved, tested, a shared one fetched from a list without saving it, started with shared memory and read for Needs you and Done, one that speaks ACP as a chat and at a Round Table of two of its chats, named channels and budgets, retained native conversation identity, pinned labels and prepared requests across restart, recovery diagnostics, scoped unified search with private-file exclusions and explicit output search, reviewed Git stage/commit/local push, fixture PR body-file flow on Unix, reusable templates/rules/checks, diagnostic export, source signing status, 900×640 layout, and workflow backup restore. No real provider inference or GitHub PR created.');
  } finally {await app?.close().catch(()=>{});await removeFolder(root);}
})().catch((error)=>{console.error(error);process.exitCode=1;});
