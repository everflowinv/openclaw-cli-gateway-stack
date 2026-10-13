const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequesterContext } = require('./requester-context.cjs');
const { waitForSpawnedRuns } = require('./spawned-run-wait.cjs');
test('requester defaults are isolated and tool arguments cannot replace the transport', () => {
  const a=createRequesterContext(), b=createRequesterContext({sessionKey:'main'});
  assert.notEqual(a.sessionKey,b.sessionKey);
  assert.match(a.sessionKey,/^agent:main:mcp:/);
  const bound=createRequesterContext({sessionKey:'agent:work:request'});
  assert.equal(bound.resolve(), 'agent:work:request');
  assert.equal(bound.resolve('agent:work:request'),bound.sessionKey);
  assert.throws(()=>bound.resolve('agent:main:main'),/bound/);
});
const receipt=(id,more={})=>({runId:id,status:'ok',endedAt:123,terminalReceipt:{runId:id},terminalReply:{disposition:'visible',text:'child final'},...more});
async function fixture(observe) {
  let clock=0; const removed=[];
  const result=await waitForSpawnedRuns({entries:[{runId:'child',childSessionKey:'agent:work:subagent:one'}],observe,remove:id=>removed.push(id),timeoutMs:500,now:()=>clock,delay:async ms=>{clock+=ms;}});
  return {result,removed};
}
test('only matching terminal evidence settles and returns child reply to caller',async()=>{
  const {result,removed}=await fixture(async()=>receipt('child'));
  assert.equal(result.status,'completed');assert.equal(result.subagents[0].reply,'child final');
  assert.deepEqual(removed,['child']);
});
test('unrelated, pending, missing-reply and transport failures retain pending run',async()=>{
  for (const value of [receipt('other'),receipt('child',{terminalReceipt:{runId:'other'}}),receipt('child',{endedAt:undefined}),receipt('child',{terminalReply:undefined}),receipt('child',{pendingError:true}),new Error('offline')]) {
    const {result,removed}=await fixture(async()=>{if(value instanceof Error)throw value;return value;});
    assert.equal(result.status,'timeout');assert.deepEqual(result.pending,['child']);assert.deepEqual(removed,[]);
  }
});
test('silent completion and terminal error remain distinct',async()=>{
  for (const [status,disposition,expected] of [['ok','silent','completed'],['error','empty','error']]) {
    const {result}=await fixture(async()=>receipt('child',{status,terminalReply:{disposition}}));
    assert.equal(result.status,expected);assert.equal(result.subagents[0].reply,undefined);
  }
});
