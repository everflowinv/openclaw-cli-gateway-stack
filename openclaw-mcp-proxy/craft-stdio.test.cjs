const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCraftBridge } = require('./craft-stdio.cjs');

function fixture(t, filter) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-bridge-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock.cjs');
  fs.writeFileSync(mock, `const rl=require('node:readline').createInterface({input:process.stdin});
let value=0; rl.on('line',async line=>{const m=JSON.parse(line);if(m.id==null)return; let result={};
if(m.method==='tools/list')result={tools:['set','get','image','error','hang'].map(name=>({name,inputSchema:{type:'object'}}))};
if(m.method==='tools/call') {const n=m.params.name;if(n==='hang')return;
if(n==='set'){await new Promise(r=>setTimeout(r,30));value=m.params.arguments.value;}
result=n==='image'?{content:[{type:'image',data:'YQ==',mimeType:'image/png'}],structuredContent:{value}}:
{content:[{type:'text',text:String(value)}],isError:n==='error'};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  fs.writeFileSync(path.join(dir, 'openclaw.json'), JSON.stringify({mcp:{servers:{gridcraft:{transport:'stdio',command:process.execPath,args:[mock],requestTimeoutMs:500,toolFilter:filter}}}}));
  function bridge(options={}) { const b=createCraftBridge({openclawHome:dir,log:()=>{},...options});t.after(()=>b.close());return b; }
  return bridge;
}

test('persists ordered state, isolates clients, preserves image and recoverable errors',async t=>{
  const make=fixture(t);const a=make(),b=make();await Promise.all([a.ready,b.ready]);
  assert.equal(a.tools.length,5);
  const [set,get]=await Promise.all([a.call('gridcraft__set',{value:42}),a.call('gridcraft__get')]);
  assert.equal(get.content[0].text,'42');assert.equal(set.isError,false);
  assert.equal((await b.call('gridcraft__get')).content[0].text,'0');
  assert.equal((await a.call('gridcraft__image')).content[0].type,'image');
  assert.equal((await a.call('gridcraft__image')).structuredContent.value,42);
  assert.equal((await a.call('gridcraft__error')).isError,true);
  assert.equal((await a.call('gridcraft__get')).content[0].text,'42');
});
test('server filters and caller allowlist intersect; restricted Desktop gets none',async t=>{
  const make=fixture(t,{include:['g*','s*'],exclude:['set']});
  const allowlist=new Set(['gridcraft__get','gridcraft__image']);
  const a=make({allowlist,isToolAllowed:n=>allowlist.has(n)}),b=make({disabled:true}),c=make({allowlist:new Set(['read'])});
  await Promise.all([a.ready,b.ready,c.ready]);assert.deepEqual(a.tools.map(t=>t.name),['gridcraft__get']);
  assert.equal(b.tools.length,0);assert.equal(c.tools.length,0);assert.equal(a.has('gridcraft__set'),false);
});
test('uncertain timeout closes client instead of silently replaying mutations',async t=>{
  const a=fixture(t)();await a.ready;
  await assert.rejects(a.call('gridcraft__hang'),/timed out/);
  await assert.rejects(a.call('gridcraft__get'),/timed out/);
});
