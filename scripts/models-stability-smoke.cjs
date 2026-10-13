const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright-core');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hub-models-stability-'));const bin=path.join(root,'bin'),project=path.join(root,'project');await Promise.all([bin,project].map(folder=>fs.mkdir(folder)));
 const fixture=await fs.readFile(path.join(__dirname,'fixtures/interactive-cli.cjs'),'utf8');
 for(const engine of ['claude','codex']){
  if(process.platform==='win32'){const folder=path.join(bin,'node_modules',...(engine==='claude'?'@anthropic-ai/claude-code':'@openai/codex').split('/'));await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'package.json'),JSON.stringify({bin:{[engine]:'fixture.cjs'}}));await fs.writeFile(path.join(folder,'fixture.cjs'),fixture);await fs.writeFile(path.join(bin,engine+'.cmd'),'@echo off\r\n');}
  else await fs.writeFile(path.join(bin,engine),'#!/usr/bin/env node\n'+fixture,{mode:0o755});
 }
 const env={...process.env,CODING_HUB_STORAGE_DIR:path.join(root,'storage'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),CODEX_HOME:path.join(root,'codex')};delete env.ELECTRON_RUN_AS_NODE;
 const key=Object.keys(env).find(name=>name.toUpperCase()==='PATH')||'PATH';env[key]=bin+path.delimiter+env[key];
 const args=['--user-data-dir='+path.join(root,'profile'),path.resolve(__dirname,'..'),'--production'];if(process.env.CODING_HUB_TEST_NO_SANDBOX==='1')args.unshift('--no-sandbox','--disable-gpu','--disable-dev-shm-usage');
 let app;const errors=[];let claude;
 const native=async(page,method,request)=>{const result=await page.evaluate(({method,request})=>window.codingHub[method](request),{method,request});assert.equal(result.ok,true,result.error?.message);return result.value;};
 const wb=(page,request)=>native(page,'workbench',request);
 async function launch(){app=await _electron.launch({executablePath:require('electron'),args,env});const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.waitForSelector('.session-tile');await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});});return page;}
 try{
  let page=await launch();await page.evaluate(()=>{window.events=[];window.codingHub.onSessionEvent(event=>window.events.push(event));});
  await app.evaluate(({dialog},project)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[project]});},project);await page.getByRole('button',{name:'Open project',exact:true}).click();
  const tile=page.locator('.session-tile').nth(1);await page.getByRole('button',{name:'Engine settings for session 2',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('datalist option')].some(option=>option.value==='fixture-hidden-model'));
  const options=await tile.locator('datalist option').evaluateAll(nodes=>nodes.map(node=>node.value));assert.deepEqual(options,['fixture-current-model','fixture-extra-model','fixture-hidden-model']);assert.ok(!options.some(value=>value.startsWith('picker-')));
  await tile.getByLabel('Reasoning effort',{exact:true}).selectOption('none');await tile.getByLabel('codex model',{exact:true}).fill('fixture-hidden-model');assert.equal(await tile.getByLabel('Reasoning effort',{exact:true}).inputValue(),'');assert.ok((await tile.textContent()).includes('reasoning has been reset') || (await tile.textContent()).includes('Reasoning has been reset'));await tile.getByLabel('Reasoning effort',{exact:true}).selectOption('ultra');
  await page.getByRole('button',{name:'Engine settings for session 2',exact:true}).click();await tile.getByRole('button',{name:'Start session',exact:true}).click();
  await page.waitForFunction(()=>window.events.some(event=>event.data?.includes('MODEL_OVERRIDE:fixture-hidden-model')));await tile.getByRole('button',{name:'Stop',exact:true}).click();
  await page.locator('.navigation').getByRole('button',{name:'Settings',exact:true}).click();await page.locator('summary').filter({hasText:'Application stability & crash diagnostics'}).click();await page.getByLabel('Application lifecycle report',{exact:true}).waitFor();assert.equal(await page.getByLabel('Enable terminal WebGL acceleration',{exact:true}).isChecked(),false);
  await page.getByRole('button',{name:'Workspace',exact:true}).click();const first=page.locator('.session-tile').first();await first.getByRole('button',{name:'Start session',exact:true}).click();await page.waitForFunction(()=>window.events.some(event=>event.type==='started'&&event.engine==='claude'));
  claude=await page.evaluate(()=>window.events.find(event=>event.type==='started'&&event.engine==='claude'));
  await page.getByRole('link',{name:'AI Coding Hub home',exact:true}).click();assert.equal(await first.getByRole('button',{name:'Stop',exact:true}).isVisible(),true);assert.doesNotThrow(()=>process.kill(claude.pid,0));
  const child=app.process();await app.evaluate(async({BrowserWindow})=>{
   const window=BrowserWindow.getAllWindows().find(window=>window.getTitle()==='AI Coding Hub');
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Renderer recovery did not reload')),15000);window.webContents.once('did-finish-load',()=>{clearTimeout(timer);resolve();});window.webContents.forcefullyCrashRenderer();});
   const deadline=Date.now()+10000;while(Date.now()<deadline){if(await window.webContents.executeJavaScript('document.querySelectorAll(\'.session-tile\').length === 2'))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Recovered workspace did not render');
  });assert.equal(child.exitCode,null,'The native host must survive renderer failure');assert.throws(()=>process.kill(claude.pid,0));
  // Playwright marks the original Page crashed. Verify the recovered renderer
  // through Electron instead of reusing that permanently cancelled Page scope.
  const result=await app.evaluate(async({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.getTitle()==='AI Coding Hub').webContents.executeJavaScript('window.codingHub.workbench({action:\"host-health\"})'));assert.equal(result.ok,true);const health=result.value;assert.ok(health.events.some(event=>event.event==='renderer-process-gone'&&event.reason==='crashed'));assert.ok(!JSON.stringify(health).includes('MODEL_OVERRIDE'));
  await app.close();app=null;page=await launch();assert.equal((await wb(page,{action:'host-health'})).previousShutdown,'clean');assert.equal((await native(page,'loadWorkspace')).workspace.sessions[1].config.model,'fixture-hidden-model');
  assert.deepEqual(errors,[]);console.log('PASS: full paginated/hidden CLI model catalog, exact selected model and raw effort delivery, software terminal default, private lifecycle diagnostics, renderer crash recovery with Claude process cleanup, saved model persistence and clean restart. Fixture CLIs; the reported Windows host crash cause is not reproduced.');
 }finally{if(app)await app.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
