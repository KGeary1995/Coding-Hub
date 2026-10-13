import { describe, expect, it, vi } from 'vitest';
import { ModelCatalog } from './model-catalog';
import type { Executable } from './discovery';
const script = (mode = 'normal') => `
const readline=require('node:readline');
const model=(model,hidden=false)=>({id:'picker-'+model,model,displayName:'Displayed '+model,description:'Exact CLI model',hidden,isDefault:!hidden,supportedReasoningEfforts:[{reasoningEffort:'minimal',description:'Minimal'},{reasoningEffort:'high',description:'High'}]});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(!request.id)return;
 if(request.method==='initialize'){process.stdout.write(JSON.stringify({id:request.id,result:{userAgent:'fixture'}})+'\\n');return;}
 if(request.method!=='model/list'||request.params.includeHidden!==true)throw Error('Unsupported operation');
 if('${mode}'==='timeout')return;
 if('${mode}'==='malformed'){process.stdout.write('not JSON\\n');return;}
 if('${mode}'==='error'){process.stdout.write(JSON.stringify({id:request.id,error:{message:'credential-do-not-leak'}})+'\\n');return;}
 const result=request.params.cursor?{data:[model('custom/provider-new-model',true)],nextCursor:'${mode}'==='loop'?'next':null}:{data:[model('custom/provider-model')],nextCursor:'next'};
 process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});`;
function fixture(mode?: string) {
 const executable: Executable = { file:process.execPath,prefixArgs:['-e',script(mode),'--'],extraEnv:{},displayPath:'fixture-codex' };
 const find=vi.fn(async()=>executable);const service=new ModelCatalog({find,timeout:mode==='timeout'?100:3000});return {service,find};
}
describe('official CLI model catalog discovery',()=>{
 it('initializes through stdio, follows every page including hidden models and returns CLI model values rather than picker IDs',async()=>{
  const {service}=fixture();try{const catalog=await service.execute({action:'codex-models',directory:process.cwd()});expect(catalog.models.map(m=>m.model)).toEqual(['custom/provider-model','custom/provider-new-model']);expect(catalog.models[1].hidden).toBe(true);expect(catalog.models[0].reasoningEfforts).toEqual(['minimal','high']);expect(JSON.stringify(catalog)).not.toContain('picker-');}finally{service.close();}
 });
 it('deduplicates concurrent requests for the same working directory',async()=>{
  const {service,find}=fixture();try{const requests=await Promise.all([service.execute({action:'codex-models',directory:process.cwd()}),service.execute({action:'codex-models',directory:process.cwd()})]);expect(find).toHaveBeenCalledTimes(1);expect(requests[0]).toEqual(requests[1]);}finally{service.close();}
 });
 it('rejects failures and timeout without exposing raw server diagnostics or fabricating model choices',async()=>{
  for(const mode of ['error','timeout','loop','malformed']){const {service}=fixture(mode);try{const failure=await service.execute({action:'codex-models',directory:process.cwd()}).then(()=>null,error=>error);expect(failure).toMatchObject({code:mode==='timeout'?'MODEL_TIMEOUT':'MODEL_CATALOG'});expect(String(failure)).not.toContain('credential-do-not-leak');}finally{service.close();}}
 });
 it('validates request fields and refuses discovery after shutdown',()=>{
  const {service}=fixture();expect(()=>service.execute({action:'codex-models',directory:process.cwd(),command:'arbitrary'})).toThrow();service.close();expect(()=>service.execute({action:'codex-models',directory:process.cwd()})).toThrow('shutting down');
 });
});
