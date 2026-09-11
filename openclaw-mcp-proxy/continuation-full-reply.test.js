"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { expandContinuationReply, producerPreview } = require("./continuation-full-reply");
const { waitForYieldContinuation } = require("./direct-agent-continuation");

function fixture(text) {
  const candidate = {runId:"continuation-run",inputId:"input"};
  const wait = {runId:candidate.runId,status:"ok",endedAt:123,
    terminalReceipt:{runId:candidate.runId,sessionId:"session"},
    terminalReply:{disposition:"visible",text:producerPreview(text)}};
  const terminal = {status:"ok",reply:wait.terminalReply.text,replySource:"native_terminal_snapshot",replyLimitChars:4096,replyMayBeTruncated:text.length>4096};
  const snapshot = {sessionId:"session",entries:[
    {id:"input",type:"message",message:{role:"user",idempotencyKey:candidate.runId+":user"}},
    {id:"final",type:"message",message:{role:"assistant",stopReason:"stop",provider:"openai",__openclaw:{runId:candidate.runId},content:[
      {type:"thinking",thinking:"PRIVATE REASONING"},
      {type:"text",text,textSignature:JSON.stringify({phase:"final_answer"})}]}}
  ]};
  return {candidate,wait,terminal,snapshot};
}
const expand = (f, max) => expandContinuationReply(f.snapshot,f.candidate,f.wait,f.terminal,max);

test("6000, 100000 and 400000 characters survive intact including tail", () => {
  for (const length of [6000,100000,400000]) {
    const tail="TAIL-END-123456";
    const text="测".repeat(length-tail.length)+tail;
    const result=expand(fixture(text));
    assert.equal(result.reply,text);
    assert.equal(result.replySource,"verified_continuation_transcript");
    assert.equal(result.replyOriginalChars,length);
    assert.equal(result.replyLimitChars,400000);
    assert.equal(result.replyTruncated,false);
    assert.equal(result.fullReplyAvailable,true);
    assert.ok(!result.reply.includes("PRIVATE REASONING"));
  }
});
test("over-limit output is bounded, marked and preserves attachment tail", () => {
  const tail='[[EVE_ATTACHMENT:{"path":"/synthetic/only.md"}]]';
  const text="汉😀字".repeat(110000)+tail;
  const result=expand(fixture(text));
  assert.ok(result.reply.length<=400000);
  assert.equal(result.replyTruncated,true);
  assert.equal(result.replyMayBeTruncated,true);
  assert.ok(result.reply.endsWith(tail));
  assert.ok(result.reply.includes("已截短"));
  assert.equal(result.reply.isWellFormed(),true);
});
test("native UTF-16 cap and trailing whitespace match exactly", () => {
  for (const text of ["a".repeat(4094)+"😀"+"余".repeat(6000),"a".repeat(4090)+" \n\t   "+"余".repeat(6000)]) {
    const result=expand(fixture(text));
    assert.equal(result.reply,text.trim());
    assert.equal(result.reply.isWellFormed(),true);
  }
});
test("wrong run/session/input or absent owner metadata never expands", () => {
  for (const mutate of [
    f=>{f.wait.runId="wrong";},f=>{f.wait.terminalReceipt.sessionId="wrong";},
    f=>{delete f.wait.terminalReceipt;},f=>{f.snapshot.entries[0].id="wrong";},
    f=>{f.snapshot.entries[1].message.__openclaw.runId="wrong";},
    f=>{delete f.snapshot.entries[1].message.__openclaw;},
    f=>{f.wait.yielded=true;},f=>{f.wait.aborted=true;},
  ]) {
    const f=fixture("长".repeat(6000));mutate(f);
    const result=expand(f);
    assert.equal(result.fullReplyAvailable,false);
    assert.equal(result.reply,f.terminal.reply);
  }
});
test("same prefix in an old run, duplicate final or changed final is not enough", () => {
  for (const mutate of [
    f=>{f.snapshot.entries[1].message.__openclaw.runId="old-run";},
    f=>{f.snapshot.entries.push(structuredClone(f.snapshot.entries[1]));},
    f=>{f.wait.terminalReply.text="different preview";},
    f=>{f.snapshot.entries[1].message.stopReason="toolUse";},
    f=>{f.snapshot.entries[1].message.content[1].textSignature=JSON.stringify({phase:"commentary"});},
    f=>{f.snapshot.entries[1].message.display=false;},
    f=>{f.snapshot.entries[1].message.provider="openclaw";},
  ]) {
    const f=fixture("长".repeat(6000));mutate(f);
    assert.equal(expand(f).fullReplyAvailable,false);
  }
});
test("private metadata after the 4096 prefix cannot leak through expansion", () => {
  for (const suffix of ["\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nPRIVATE",
    "\nContext: ⟦openclaw:ctx⟧\nPRIVATE", "\n<active_memory_plugin>PRIVATE",
    "\nDelivery: Final assistant text is not automatically delivered in this run. PRIVATE"]) {
    const f=fixture("长".repeat(6000)+suffix);
    const result=expand(f);
    assert.equal(result.fullReplyAvailable,false);
    assert.ok(!result.reply.includes("PRIVATE"));
  }
});
test("new input boundary prevents borrowing later final", () => {
  const f=fixture("长".repeat(6000));
  f.snapshot.entries.splice(1,0,{id:"new",type:"message",message:{role:"user",idempotencyKey:"other:user"}});
  assert.equal(expand(f).fullReplyAvailable,false);
});
test("caller cap cannot exceed 400000; small custom cap is enforced", () => {
  const f=fixture("字".repeat(450000));
  assert.equal(expand(f,999999999).replyLimitChars,400000);
  for (const cap of [1,50,1000,10000]) {
    const result=expand(f,cap);
    assert.ok(result.reply.length<=cap);
    assert.equal(result.replyLimitChars,cap);
    assert.equal(result.replyTruncated,true);
  }
});
test("yield waiter promotes a verified long final rather than its 4096 preview", async () => {
  const key="agent:main:codex-desktop-lumos";
  const run=`announce:requester-settle:main:${key}:child-run:yield-1`;
  const text="长正文".repeat(10000)+"FINAL-TAIL";
  const f=fixture(text);f.candidate.runId=run;f.wait.runId=run;f.wait.terminalReceipt.runId=run;
  f.snapshot.entries[0].message.idempotencyKey=run+":user";
  f.snapshot.entries[0].message.provenance={kind:"inter_session",sourceTool:"subagent_announce",sourceSessionKey:"agent:main:subagent:child"};
  f.snapshot.entries[1].message.__openclaw.runId=run;
  const event=(id,message)=>({id,type:"message",message});
  f.snapshot.entries.unshift(
    event("root",{role:"user",idempotencyKey:"root-run:user"}),
    event("spawn",{role:"assistant",content:[{type:"toolCall",name:"sessions_spawn",id:"spawn-call",arguments:{}}]}),
    event("receipt",{role:"toolResult",toolCallId:"spawn-call",toolName:"sessions_spawn",details:{status:"accepted",runId:"child-run",childSessionKey:"agent:main:subagent:child"}}),
    event("yield",{role:"assistant",content:[{type:"toolCall",name:"sessions_yield",id:"yield-call"}]}));
  const result=await waitForYieldContinuation({sessionKey:key,runId:"root-run",deadlineAt:Date.now()+1000,
    readSnapshot:()=>f.snapshot,waitForRun:async()=>f.wait});
  assert.equal(result.reply,text);
  assert.equal(result.replyTruncated,false);
  assert.equal(result.continuationRunId,run);
});
