import { afterEach, describe, expect, it } from 'vitest';
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
import { difference } from './visual-diff';
import { budgetAlerts, recoveryAdvice, redactDiagnostic } from '../../../shared/productivity';
import type { SavedWorkspace } from '../../../shared/types';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach((root)=>fs.rmSync(root,{recursive:true,force:true})));
function root(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-productivity-'));roots.push(dir);return dir;}
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8',stdio:'pipe'}).trim();
function workspace(cwd:string):SavedWorkspace {const ids=[randomUUID(),randomUUID()];return {version:1,rootDirectory:cwd,sessions:ids.map((id,index)=>({id,title:index?'Codex':'Claude',createdAt:new Date().toISOString(),config:index?{engine:'codex',model:'',reasoningEffort:null,resumeId:randomUUID()}:{engine:'claude',model:'',thinking:{budget_tokens:null},tokenLimits:{maxOutputTokens:null,maxSessionTokens:null}},binding:{mode:'workspace'},budget:{tokens:100,costUSD:null,contextPercent:85},preparedRequest:{label:'Send request',prompt:'Private prepared request'}})),tiles:ids.map((sessionId,index)=>({sessionId,x:index*6,y:0,w:6,h:12,minW:3,minH:10})),layoutMode:'columns',focusedSessionId:null};}
describe('reviewed Git delivery',()=>{
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
});
describe('durable workflow records and bounded search',()=>{
 it('captures reusable parameters without requests/resume IDs and applies fresh identities and project rules',async()=>{
  const data=root();const project=root();const target=root();const storage=new WorkspaceStorage(data);try{const rules=new RulesService(data);const checks=new Verification(data,async()=>true);const service=new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),checks,rules,storage,async()=>true);const original=workspace(project);const item=await service.execute({action:'flow-template-save',name:'Paired review',description:'Two agents',workspace:original,includeRules:true,includeChecks:true}) as any;
   expect(item.workspace.sessions[1].config.resumeId).toBeUndefined();expect(item.workspace.sessions[0].preparedRequest).toBeUndefined();const applied=await service.execute({action:'flow-template-apply',id:item.id,directory:target,applyRules:false,applyChecks:true}) as SavedWorkspace;expect(applied.rootDirectory).toBe(target);expect(applied.sessions[0].id).not.toBe(original.sessions[0].id);expect(applied.sessions[0].budget?.tokens).toBe(100);expect(new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),checks,rules,storage,async()=>false).templates()).toHaveLength(1);
  }finally{storage.close();}
 });
 it('searches files, memory, rules and annotations while skipping credential paths and symlink escapes',async()=>{
  const data=root();const project=root();const outside=root();fs.writeFileSync(path.join(project,'source.ts'),'needle source');fs.writeFileSync(path.join(project,'.env'),'needle secret');fs.writeFileSync(path.join(outside,'escape.ts'),'needle escaped');if(process.platform!=='win32')fs.symlinkSync(outside,path.join(project,'linked'));
  fs.mkdirSync(path.join(data,'memory','demo'),{recursive:true});fs.writeFileSync(path.join(data,'memory','demo','note.json'),JSON.stringify({title:'Note',project:'demo',content:'needle handoff'}));fs.writeFileSync(path.join(data,'design-annotations.json'),JSON.stringify([{snapshotId:randomUUID(),text:'needle annotation'}]));const storage=new WorkspaceStorage(data);try{const rules=new RulesService(data);const current=rules.read([]);rules.save('needle rules',current.revision,[]);const service=new Workflows(data,new NativeSessions(new ClaudeProfiles(data)),new Verification(data,async()=>false),rules,storage,async()=>false);const result=await service.execute({action:'flow-search',query:'needle',directory:project,includeOutput:false}) as any;
  expect(result.hits.map((hit:any)=>hit.kind).sort()).toEqual(['annotation','file','memory','rules']);expect(JSON.stringify(result)).not.toContain('needle secret');expect(JSON.stringify(result)).not.toContain('needle escaped');
  }finally{storage.close();}
 });
});
describe('usage targets and screenshot evidence',()=>{
 it('does not invent cost or double count cached Codex input and reasoning',()=>{
  const usage:any={engine:'codex',input:100,output:25,cached:20,cacheWrite:0,reasoning:10,cost:null,context:{used:850,limit:1000}};
  expect(budgetAlerts({tokens:126,costUSD:1,contextPercent:85},usage)).toEqual(['Context usage reached 85%']);expect(budgetAlerts({tokens:125,costUSD:1,contextPercent:90},usage)).toHaveLength(1);expect(budgetAlerts({tokens:1,costUSD:1,contextPercent:1},undefined)).toEqual([]);
 });
 it('measures changed pixels and refuses mismatched bitmap dimensions',()=>{
  const original=Buffer.from([0,0,0,255,0,0,0,255]);const edited=Buffer.from([0,0,0,255,100,0,0,255]);expect(difference(original,edited,2,1,20).changedPixels).toBe(1);expect(difference(original,edited,2,1,120).changedPixels).toBe(0);expect(()=>difference(original,edited,3,1,20)).toThrow('dimensions');
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
  expect(recoveryAdvice('CLI exited with code 1. No terminal error was reported. Try the CLI directly in PowerShell from this project directory.',1,true).view).toBe('accounts');
  expect(recoveryAdvice('The working directory does not exist or is not accessible.',null,true).view).toBe('projects');
 });
});
