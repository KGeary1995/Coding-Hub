import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Delivery } from './delivery';
import { Workflows } from './workflows';
import { NativeSessions } from './native-sessions';
import { ClaudeProfiles } from '../cli/claude-profiles';
import { Verification } from './verification';
import { RulesService } from '../hub/rules';
import { WorkspaceStorage } from '../storage/workspace-storage';
import { budgetAlerts, recoveryAdvice, redactDiagnostic } from '../../../shared/productivity';
import type { SavedWorkspace } from '../../../shared/types';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach((root)=>fs.rmSync(root,{recursive:true,force:true})));
// Delivery runs git with the user's environment; CI runners have no commit identity configured.
const identity={GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};const savedIdentity:Record<string,string|undefined>={};
beforeAll(()=>{for(const [key,value] of Object.entries(identity)){savedIdentity[key]=process.env[key];process.env[key]=value;}});
afterAll(()=>{for(const [key,value] of Object.entries(savedIdentity)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
function root(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-productivity-'));roots.push(dir);return dir;}
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8',stdio:'pipe'}).trim();
function workspace(cwd:string):SavedWorkspace {const ids=[randomUUID(),randomUUID()];return {version:1,rootDirectory:cwd,sessions:ids.map((id,index)=>({id,title:index?'Codex':'Claude',createdAt:new Date().toISOString(),config:index?{engine:'codex',model:'',reasoningEffort:null,resumeId:randomUUID()}:{engine:'claude',model:'',thinking:{budget_tokens:null},tokenLimits:{maxOutputTokens:null,maxSessionTokens:null}},binding:{mode:'workspace'},budget:{tokens:100,costUSD:null,contextPercent:85},preparedRequest:{label:'Send request',prompt:'Private prepared request'}})),tiles:ids.map((sessionId,index)=>({sessionId,x:index*6,y:0,w:6,h:12,minW:3,minH:10})),layoutMode:'columns',focusedSessionId:null};}
// Each review runs several Git commands, which take a while to start on Windows CI runners.
describe('reviewed Git delivery',{timeout:30000},()=>{
 it('says a folder outside Git is not a repository',async()=>{
  await expect(new Delivery(async()=>true,()=>{}).inspect(root())).rejects.toMatchObject({code:'NOT_A_REPOSITORY'});
 });
 it('preserves the index on cancellation and commits only explicitly staged literal paths',async()=>{
  const cwd=root();git(cwd,'init','-b','main');fs.writeFileSync(path.join(cwd,'--literal.txt'),'selected');fs.writeFileSync(path.join(cwd,'other.txt'),'leave alone');let approved=false;const service=new Delivery(async()=>approved,()=>{});
  let state=await service.inspect(cwd);expect(await service.execute({action:'flow-git-stage',directory:cwd,revision:state.revision,paths:['--literal.txt']})).toBeNull();expect(git(cwd,'diff','--cached','--name-only')).toBe('');approved=true;
  await service.execute({action:'flow-git-stage',directory:cwd,revision:state.revision,paths:['--literal.txt']});state=await service.inspect(cwd);expect(state.staged).toEqual(['--literal.txt']);await service.execute({action:'flow-git-commit',directory:cwd,revision:state.revision,message:'Reviewed change'});expect(git(cwd,'show','HEAD:--literal.txt')).toBe('selected');expect((await service.inspect(cwd)).unstaged).toEqual(['other.txt']);
 });
 it('rejects content changed while review is open',async()=>{
  const cwd=root();git(cwd,'init','-b','main');const file=path.join(cwd,'file.txt');fs.writeFileSync(file,'before');const service=new Delivery(async()=>{fs.writeFileSync(file,'after');return true;},()=>{});const state=await service.inspect(cwd);
  await expect(service.execute({action:'flow-git-stage',directory:cwd,revision:state.revision,paths:['file.txt']})).rejects.toMatchObject({code:'DELIVERY_STALE'});expect(git(cwd,'diff','--cached','--name-only')).toBe('');
 });
 it('binds each untracked file separately rather than hashing concatenated content',async()=>{
  const cwd=root();git(cwd,'init','-b','main');fs.writeFileSync(path.join(cwd,'a.txt'),'a');fs.writeFileSync(path.join(cwd,'b.txt'),'bc');const service=new Delivery(async()=>true,()=>{});const before=await service.inspect(cwd);fs.writeFileSync(path.join(cwd,'a.txt'),'ab');fs.writeFileSync(path.join(cwd,'b.txt'),'c');expect((await service.inspect(cwd)).revision).not.toBe(before.revision);
 });
 it('rejects a changed remote destination during confirmation',async()=>{
  const cwd=root();const original=root();const replacement=root();git(original,'init','--bare');git(replacement,'init','--bare');git(cwd,'init','-b','main');fs.writeFileSync(path.join(cwd,'file.txt'),'review');git(cwd,'add','.');git(cwd,'commit','-m','Baseline');git(cwd,'remote','add','origin',original);
  const service=new Delivery(async()=>{git(cwd,'remote','set-url','origin',replacement);return true;},()=>{});const status=await service.inspect(cwd);await expect(service.execute({action:'flow-git-push',directory:cwd,revision:status.revision,remote:'origin'})).rejects.toMatchObject({code:'DELIVERY_STALE'});expect(()=>git(original,'rev-parse','main')).toThrow();expect(()=>git(replacement,'rev-parse','main')).toThrow();
 });
 it('pushes the reviewed branch to a local bare remote without force',async()=>{
  const cwd=root();const remote=root();git(remote,'init','--bare');git(cwd,'init','-b','main');fs.writeFileSync(path.join(cwd,'file.txt'),'baseline');git(cwd,'add','.');git(cwd,'commit','-m','Baseline');git(cwd,'remote','add','origin',remote);const service=new Delivery(async()=>true,()=>{});const state=await service.inspect(cwd);await service.execute({action:'flow-git-push',directory:cwd,revision:state.revision,remote:'origin'});expect(git(remote,'rev-parse','main')).toBe(git(cwd,'rev-parse','HEAD'));
 });
 it('says why Git refused a push, and names an untracked file too large to review',async()=>{
  const cwd=root();const other=root();const remote=root();git(remote,'init','--bare');
  for(const dir of [other,cwd]){git(dir,'init','-b','main');fs.writeFileSync(path.join(dir,'file.txt'),dir);git(dir,'add','.');git(dir,'commit','-m','Diverged');git(dir,'remote','add','origin',remote);}
  git(other,'push','origin','main');const service=new Delivery(async()=>true,()=>{});const state=await service.inspect(cwd);
  await expect(service.execute({action:'flow-git-push',directory:cwd,revision:state.revision,remote:'origin'})).rejects.toThrow(/git said:[\s\S]*rejected/);
  fs.writeFileSync(path.join(cwd,'big.bin'),Buffer.alloc(5*1024*1024));await expect(service.inspect(cwd)).rejects.toThrow('big.bin');
 });
});
describe('durable workflow records and bounded search',()=>{
 it('captures reusable parameters without requests/resume IDs and applies fresh identities and project rules',async()=>{
  const data=root();const project=root();const target=root();const storage=new WorkspaceStorage(data);try{const rules=new RulesService(data);const checks=new Verification(data,async()=>true);const service=new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),checks,rules,storage,async()=>true);const original=workspace(project);const item=await service.execute({action:'flow-template-save',name:'Paired review',description:'Two agents',workspace:original,includeRules:true,includeChecks:true}) as any;
   expect(item.workspace.sessions[1].config.resumeId).toBeUndefined();expect(item.workspace.sessions[0].preparedRequest).toBeUndefined();const applied=await service.execute({action:'flow-template-apply',id:item.id,directory:target,applyRules:false,applyChecks:true}) as SavedWorkspace;expect(applied.rootDirectory).toBe(target);expect(applied.sessions[0].id).not.toBe(original.sessions[0].id);expect(applied.sessions[0].budget?.tokens).toBe(100);expect(new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),checks,rules,storage,async()=>false).templates()).toHaveLength(1);
  }finally{storage.close();}
 });
 it('applies a template saved while a channel led a hierarchy Round Table, with its seats and without the table’s work',async()=>{
  const data=root();const project=root();const target=root();const storage=new WorkspaceStorage(data);try{const rules=new RulesService(data);const checks=new Verification(data,async()=>true);const service=new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),checks,rules,storage,async()=>true);
   const original=workspace(project);const [lead,reviewer]=original.sessions;const planner={...lead,id:randomUUID(),title:'Planner'};original.sessions.push(planner);original.tiles=[{...original.tiles[0],w:12}];
   lead.roundTable={partner:reviewer.id,driver:'claude',rounds:2,kind:'hierarchy',planner:planner.id,chain:{step:'reviewing',task:'Private task',plan:'Private plan',report:'',reviewRound:1,finalRound:0,verdict:null,note:''},findings:[{id:'F1',severity:'high',evidence:'a.ts:1',text:'Private finding',status:'open',response:'',check:'',reviewedAt:null,changedAt:null,round:1,at:new Date().toISOString()}],waiting:'Private message'};
   const item=await service.execute({action:'flow-template-save',name:'Hierarchy',description:'',workspace:original,includeRules:false,includeChecks:false}) as any;
   expect(JSON.stringify(item.workspace)).not.toMatch(/Private/);
   const applied=await service.execute({action:'flow-template-apply',id:item.id,directory:target,applyRules:false,applyChecks:false}) as SavedWorkspace;
   const table=applied.sessions[0].roundTable!;const ids=applied.sessions.map((session)=>session.id);
   expect(ids).not.toContain(reviewer.id);expect(table).toEqual({partner:ids[1],driver:'claude',rounds:2,kind:'hierarchy',planner:ids[2]});expect(applied.tiles.map((tile)=>tile.sessionId)).toEqual([ids[0]]);
  }finally{storage.close();}
 });
 it('gives a template’s named seats (1.26) their new ids, so every seat stays hidden and the same seat edits',async()=>{
  const data=root();const project=root();const target=root();const storage=new WorkspaceStorage(data);try{const rules=new RulesService(data);const checks=new Verification(data,async()=>true);const service=new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),checks,rules,storage,async()=>true);
   const original=workspace(project);const [lead,second]=original.sessions;const third={...lead,id:randomUUID(),title:'Third'};original.sessions.push(third);original.tiles=[{...original.tiles[0],w:12}];
   lead.roundTable={partner:second.id,driver:'claude',rounds:3,driverSeat:third.id,seats:[{session:lead.id},{session:second.id,name:'Tests',instructions:'Check the tests.'},{session:third.id}]};
   const item=await service.execute({action:'flow-template-save',name:'Trio',description:'',workspace:original,includeRules:false,includeChecks:false}) as any;
   const applied=await service.execute({action:'flow-template-apply',id:item.id,directory:target,applyRules:false,applyChecks:false}) as SavedWorkspace;
   const ids=applied.sessions.map((session)=>session.id);expect(ids).not.toContain(third.id);
   expect(applied.sessions[0].roundTable).toEqual({partner:ids[1],driver:'claude',rounds:3,driverSeat:ids[2],seats:[{session:ids[0]},{session:ids[1],name:'Tests',instructions:'Check the tests.'},{session:ids[2]}]});expect(applied.tiles.map((tile)=>tile.sessionId)).toEqual([ids[0]]);
  }finally{storage.close();}
 });
 it('applies a template of a Gemini chat: from 1.39 a channel of its own (up to 1.38 it was refused as 1.20’s seat)',async()=>{
  const data=root();const target=root();const storage=new WorkspaceStorage(data);try{const rules=new RulesService(data);const checks=new Verification(data,async()=>true);let asked=false;const service=new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),checks,rules,storage,async()=>{asked=true;return true;});
   const id=randomUUID();const at=new Date().toISOString();
   const gemini={version:1,rootDirectory:null,layoutMode:'columns',focusedSessionId:null,sessions:[{id:'gem',title:'Gemini',config:{engine:'gemini',model:'gemini-4-argon-high',chat:true},binding:{mode:'workspace'},createdAt:at}],tiles:[{sessionId:'gem',x:0,y:0,w:12,h:12,minW:3,minH:10}]};
   fs.writeFileSync(path.join(data,'project-templates.json'),JSON.stringify([{id,name:'Old Gemini',description:'',workspace:gemini,rules:'template rules',checks:[{name:'Check',steps:[{label:'Pass',tool:'python',args:['-c','print(1)']}],timeoutSeconds:10}],createdAt:at}]));
   expect(service.templates().map((item)=>item.id)).toEqual([id]);
   // It goes on to ask the window to open it (the test's window says yes; what follows is not this test's).
   await service.execute({action:'flow-template-apply',id,directory:target,applyRules:true,applyChecks:true}).catch(()=>{});
   expect(asked).toBe(true);
  }finally{storage.close();}
 });
 it('searches files, memory and rules (not the removed design annotations) while skipping credential paths and symlink escapes',async()=>{
  const data=root();const project=root();const outside=root();fs.writeFileSync(path.join(project,'source.ts'),'needle source');fs.writeFileSync(path.join(project,'.env'),'needle secret');fs.writeFileSync(path.join(outside,'escape.ts'),'needle escaped');if(process.platform!=='win32')fs.symlinkSync(outside,path.join(project,'linked'));
  fs.mkdirSync(path.join(data,'memory','demo'),{recursive:true});fs.writeFileSync(path.join(data,'memory','demo','note.json'),JSON.stringify({title:'Note',project:'demo',content:'needle handoff'}));fs.writeFileSync(path.join(data,'design-annotations.json'),JSON.stringify([{snapshotId:randomUUID(),text:'needle annotation'}]));const storage=new WorkspaceStorage(data);try{const rules=new RulesService(data);const current=rules.read([]);rules.save('needle rules',current.revision,[]);const service=new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),new Verification(data,async()=>false),rules,storage,async()=>false);const result=await service.execute({action:'flow-search',query:'needle',directory:project,includeOutput:false}) as any;
  expect(result.hits.map((hit:any)=>hit.kind).sort()).toEqual(['file','memory','rules']);expect(JSON.stringify(result)).not.toContain('needle secret');expect(JSON.stringify(result)).not.toContain('needle escaped');
  }finally{storage.close();}
 });
 it('still finds memory notes when a large project uses up its own search budget, without synchronous reads',async()=>{
  const data=root();const project=root();for(let i=0;i<120;i++)fs.writeFileSync(path.join(project,`f${i}.md`),'needle '+'x'.repeat(120_000));
  fs.mkdirSync(path.join(data,'memory','demo'),{recursive:true});fs.writeFileSync(path.join(data,'memory','demo','note.json'),JSON.stringify({id:randomUUID(),title:'Note',project:'demo',content:'needle handoff'}));
  const storage=new WorkspaceStorage(data);const reads=vi.spyOn(fs,'readFileSync');const lists=vi.spyOn(fs,'readdirSync');
  try{const service=new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),new Verification(data,async()=>false),new RulesService(data),storage,async()=>false);
   const result=await service.execute({action:'flow-search',query:'needle',directory:project,includeOutput:false}) as any;
   expect(result.limited).toBe(true);expect(result.hits.some((hit:any)=>hit.kind==='file')).toBe(true);expect(result.hits.filter((hit:any)=>hit.kind==='memory')).toHaveLength(1);
   expect([...reads.mock.calls,...lists.mock.calls].filter(([file])=>String(file).startsWith(project)||String(file).includes('memory'))).toEqual([]);
  }finally{reads.mockRestore();lists.mockRestore();storage.close();}
 });
});
describe('usage targets and release evidence',()=>{
 it('does not invent cost or double count cached Codex input and reasoning',()=>{
  const usage:any={engine:'codex',input:100,output:25,cached:20,cacheWrite:0,reasoning:10,cost:null,context:{used:850,limit:1000}};
  // New tokens: 80 input outside the cache + 25 output = 105 (Codex's input already includes the 20 cached).
  expect(budgetAlerts({tokens:106,costUSD:1,contextPercent:85},usage)).toEqual(['Context usage reached 85%']);expect(budgetAlerts({tokens:105,costUSD:1,contextPercent:90},usage)).toHaveLength(1);expect(budgetAlerts({tokens:1,costUSD:1,contextPercent:1},undefined)).toEqual([]);
 });
 it('redacts Windows paths before JSON encoding and blocks signed builds without credentials',()=>{
  const home='C:\\Users\\private'; const project=home+'\\project'; const report=redactDiagnostic({message:project+'\\file.ts',other:home+'\\.codex'},home,project);
  expect(JSON.stringify(report)).not.toContain('private');
  const output=root(); const build=spawnSync(process.execPath,[path.resolve('scripts/build-windows.cjs'),'--signed','--output',output],{encoding:'utf8',env:{...process.env,CSC_LINK:'',WINDOWS_PUBLISHER_NAME:''}}); expect(build.status).toBe(1);expect(build.stderr).toContain('Signed builds require');expect(fs.readdirSync(output)).toEqual([]);
 });
 it('distinguishes configuration/account/directory guidance without attributing a generic exit code',()=>{
  expect(recoveryAdvice('invalid model',1,true).title).toContain('configuration');expect(recoveryAdvice('unauthorized',1,true).view).toBe('accounts');expect(recoveryAdvice('',1,false).view).toBe('projects');expect(recoveryAdvice('',1,true).title).toBe('Investigate CLI exit 1');
 });
});

it('rejects a changed push URL while leaving the fetch URL unchanged', async () => {
 const cwd=root(), fetch=root(), first=root(), second=root();
 for (const remote of [fetch,first,second]) git(remote,'init','--bare');
 git(cwd,'init','-b','main'); fs.writeFileSync(path.join(cwd,'file.txt'),'baseline'); git(cwd,'add','.'); git(cwd,'commit','-m','Baseline');
 git(cwd,'remote','add','origin',fetch); git(cwd,'remote','set-url','--push','origin',first);
 const service=new Delivery(async()=>{git(cwd,'remote','set-url','--push','origin',second);return true;},()=>{});
 const state=await service.inspect(cwd);
 await expect(service.execute({action:'flow-git-push',directory:cwd,revision:state.revision,remote:'origin'})).rejects.toMatchObject({code:'DELIVERY_STALE'});
 expect(()=>git(first,'rev-parse','main')).toThrow(); expect(()=>git(second,'rev-parse','main')).toThrow();
});

describe('Git delivery regressions',()=>{
 it('stages a file that was renamed and then edited',async()=>{
  const cwd=root();git(cwd,'init','-b','main');fs.writeFileSync(path.join(cwd,'a.txt'),'one\ntwo\nthree\n');git(cwd,'add','.');git(cwd,'commit','-m','Baseline');
  git(cwd,'mv','a.txt','b.txt');fs.writeFileSync(path.join(cwd,'b.txt'),'one\ntwo\nthree\nfour\n');
  const service=new Delivery(async()=>true,()=>{});const state=await service.inspect(cwd);expect(state.unstaged).toContain('b.txt');
  await service.execute({action:'flow-git-stage',directory:cwd,revision:state.revision,paths:['b.txt']});
  expect(git(cwd,'status','--porcelain')).toBe('R  a.txt -> b.txt');
 });
 it('inspects a repository that contains an untracked nested repository',async()=>{
  const cwd=root();git(cwd,'init','-b','main');const nested=path.join(cwd,'nested');fs.mkdirSync(nested);git(nested,'init','-b','main');fs.writeFileSync(path.join(nested,'x.txt'),'x');git(nested,'add','.');git(nested,'commit','-m','Nested');
  const state=await new Delivery(async()=>true,()=>{}).inspect(cwd);expect(state.unstaged).toEqual([]);
 });
});

describe('Git delivery size and unborn branches',()=>{
 it('inspects tracked changes larger than the command output buffer',async()=>{
  const cwd=root();git(cwd,'init','-b','main');const file=path.join(cwd,'lock.json');fs.writeFileSync(file,'a\n'.repeat(10));git(cwd,'add','.');git(cwd,'commit','-m','Baseline');
  fs.writeFileSync(file,Array.from({length:120000},(_,i)=>`line ${i} ${'x'.repeat(30)}`).join('\n'));
  const state=await new Delivery(async()=>true,()=>{}).inspect(cwd);expect(state.unstaged).toEqual(['lock.json']);
 });
 it('unstages an edited file in a repository without commits',async()=>{
  const cwd=root();git(cwd,'init','-b','main');const file=path.join(cwd,'new.txt');fs.writeFileSync(file,'first');git(cwd,'add','.');fs.writeFileSync(file,'second');
  const service=new Delivery(async()=>true,()=>{});const state=await service.inspect(cwd);
  await service.execute({action:'flow-git-unstage',directory:cwd,revision:state.revision,paths:['new.txt']});expect(git(cwd,'diff','--cached','--name-only')).toBe('');
 });
});

describe('diagnostic helper regressions',()=>{
 it('keeps the username out of reports when the project contains the home folder',()=>{
  const report=redactDiagnostic('C:\\Users\\Bob\\AppData\\Roaming\\npm\\claude.cmd','C:\\Users\\Bob','C:\\Users') as string;expect(report).not.toContain('Bob');
 });
 it('does not send a generic CLI exit to the project picker',()=>{
  expect(recoveryAdvice('CLI exited with code 1. No terminal error was reported. Try the CLI directly in PowerShell from this project folder.',1,true).view).toBe('accounts');
  expect(recoveryAdvice('The working folder does not exist or is not accessible.',null,true).view).toBe('projects');
  expect(recoveryAdvice('The working directory does not exist or is not accessible.',null,true).view).toBe('projects');
  // A CLI's own output names its "cwd" (a start banner, the fixture's READY line): that is no folder problem either.
  expect(recoveryAdvice('CLI exited with code 1.\nREADY CWD:C:\\x\ncwd: C:\\x',1,true).title).toBe('Investigate CLI exit 1');
 });
 it('hides a folder however the report spells it, and only as a whole folder name',()=>{
  expect(redactDiagnostic('D:\\clients\\acme-corp','C:\\Users\\kg','D:\\clients\\acme-corp\\')).toBe('<project>');
  expect(redactDiagnostic('C:/Users/kg/AppData/x','C:\\Users\\kg',null)).toBe('~/AppData/x');
  expect(redactDiagnostic('C:\\Users\\kgeary\\x','C:\\Users\\kg',null)).toBe('C:\\Users\\kgeary\\x');
  expect(redactDiagnostic('/home/kg/app and /home/kg','/home/kg',null)).toBe('~/app and ~');
  expect(redactDiagnostic('/usr/bin','/home/kg','/')).toBe('/usr/bin');
  expect(redactDiagnostic('Could not open C:\\Users\\kgeary.','C:\\Users\\kgeary',null)).toBe('Could not open ~.');
  expect(redactDiagnostic('Could not read D:\\work\\client-x. Try again.','C:\\Users\\kg','D:\\work\\client-x')).toBe('Could not read <project>. Try again.');
  expect(redactDiagnostic('/Users/kg.','/Users/kg',null)).toBe('~.');expect(redactDiagnostic('/Users/kg.old/x','/Users/kg',null)).toBe('/Users/kg.old/x');
 });
 it('picks advice from words that name a cause, not from any output that contains them',()=>{
  const exit=(tail:string)=>recoveryAdvice(`CLI exited with code 1.\n${tail}`,1,true).title;
  for(const tail of ['The author field is missing in package.json','listening on port 14290','bash: jq: No such file or directory','Updated AGENTS.md then crashed: out of memory'])expect(exit(tail),tail).toBe('Investigate CLI exit 1');
  expect(exit('Error: 401 Unauthorized')).toContain('account');expect(exit('API Error: 429 rate limit')).toContain('account');expect(exit('Not logged in. Please run /login')).toContain('account');
  expect(recoveryAdvice('Apply the current Shared rules to this project before starting a channel.',null,true).view).toBe('rules');
  expect(exit('error: unknown option --foo')).toContain('configuration');
  expect(exit('OAuth token has expired')).toContain('account');expect(exit('Your token expired')).toContain('account');
 });
});
