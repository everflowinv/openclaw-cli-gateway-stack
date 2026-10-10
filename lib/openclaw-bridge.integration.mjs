import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root=process.argv[2];
if (!root || !process.argv[3]) throw new Error('Usage: node lib/openclaw-bridge.integration.mjs OPENCLAW_ROOT CONFIG_PATH');
const state=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-host-probe-'));
process.env.OPENCLAW_STATE_DIR=state;
process.env.OPENCLAW_CONFIG_PATH=path.join(state,'openclaw.json');
const captures=[];
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);captures.push(body);
 res.writeHead(200,{'content-type':'text/event-stream'});
 const msg={id:'fixture',object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta:{content:'BRIDGE_OK'},finish_reason:null}]};
 res.end(`data: ${JSON.stringify(msg)}\n\ndata: ${JSON.stringify({...msg,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})}\n\ndata: [DONE]\n\n`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const source=JSON.parse(fs.readFileSync(process.argv[3]));
const providers={};const refs=[];
for(const [name,p] of Object.entries(source.models.providers)) {
 if(!['claude-cli-gateway','antigravity-cli-gateway','muse-cli-gateway'].includes(name))continue;
 providers[name]={...p,apiKey:'test-fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,models:p.models.map(m=>{refs.push(`${name}/${m.id}`);return {...m,baseUrl:undefined};})};
}
const cfg={models:{providers},agents:{defaults:{model:{primary:refs[0]},models:Object.fromEntries(refs.map(x=>[x,{}]))},list:[{id:'bridge-fixture',agentDir:path.join(state,'agent'),model:refs[0]}]}};
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(cfg));
const runtimeFile=fs.readdirSync(path.join(root,'dist')).find(n=>/^runtime-llm\.runtime-.*\.mjs$/.test(n));
const {createRuntimeLlm}=await import(path.join(root,'dist',runtimeFile));
const runtime=createRuntimeLlm({getConfig:()=>cfg,authority:{caller:{kind:'plugin',id:'bridge-fixture'},allowComplete:true,allowModelOverride:true,allowedModels:refs,allowAgentIdOverride:true},logger:{debug(){},info(){},warn(){},error(){}}});
try {
 for(const ref of refs) for(const level of ['off','minimal','low','medium','high','xhigh','max',undefined]){
  const index=captures.length;
  let error;
  try {await runtime.complete({messages:[{role:'user',content:'BRIDGE_FIXTURE'}],model:ref,maxTokens:100,agentId:'bridge-fixture',...(level?{thinkingLevel:level}:{}),signal:AbortSignal.timeout(15000)});}catch(e){error=e.message;}
  const payload=captures[index];
  assert.equal(error, undefined, `${ref} ${level}: ${error}`);
  const effective=level??'off';
  const expected=ref.startsWith('claude-') ? ({off:'low',minimal:'low'}[effective]??effective)
    : ref.startsWith('muse-') ? (effective==='off'?'minimal':effective)
    : (['off','minimal'].includes(effective)||ref.includes('gemini-3.1-pro')&&effective==='medium'?'low':['xhigh','max'].includes(effective)?'high':effective);
  assert.equal(payload?.reasoning_effort,expected, `${ref} ${level}`);
  assert.equal(payload?.max_tokens??payload?.max_completion_tokens,100);
  console.log(JSON.stringify({model:ref,level:level??'default',effort:payload.reasoning_effort,maxTokens:100}));
 }
}finally{server.closeAllConnections();server.close();fs.rmSync(state,{recursive:true,force:true});}
