import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-search-regression-'));
const bin=path.join(root,'agy');
fs.writeFileSync(bin,`#!${process.execPath}
if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end',()=>{
const lines=[{event:'init',init:{agent:'websearch'}},{event:'step_update',step_update:{step_type:'tool',state:'DONE',tool_info:{name:'search_web'}}},{event:'result',result:{status:'SUCCESS',response:JSON.stringify({answer:'中文😀',citations:[]})}}];
const data=Buffer.from(lines.map(x=>JSON.stringify(x)+'\\n').join(''));
const split=data.indexOf(Buffer.from('😀'))+2;
process.stdout.write(data.subarray(0,split)); setTimeout(()=>process.stdout.write(data.subarray(split)),20);
});\n`,{mode:0o700});
const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
const server=spawn(process.execPath,[new URL('./websearch-service.mjs',import.meta.url).pathname],{env:{...process.env,AGY_SEARCH_PORT:String(port),AGY_CLI_BIN:bin,AGY_SEARCH_CWD:root,AGY_SEARCH_API_KEY:'',AGY_SEARCH_CACHE_TTL_MS:'0'},stdio:'ignore'});
try {
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/health`)).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,25));}
 assert.ok(ready,'service starts');
 const search=()=>fetch(`http://127.0.0.1:${port}/v1/web-search`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'synthetic fixture'})}).then(r=>r.json());
 const result=await search(); assert.match(result.content,/中文😀/);
 fs.unlinkSync(bin);
 const failed=await search();assert.equal(failed.error,'agy_search_error');assert.match(failed.message,/ENOENT/);
 assert.ok((await fetch(`http://127.0.0.1:${port}/health`)).ok,'spawn failure must not crash HTTP service');
 console.log('websearch integration: split UTF-8 and spawn failure recovery ok');
}finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('close',r));fs.rmSync(root,{recursive:true,force:true});}
