import { checkCancelledQueue } from '../lib/http-regressions.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: payload ? {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      } : undefined,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestRaw(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
      headers: {"content-type": "application/json", "content-length": Buffer.byteLength(payload)},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.once("error", reject);
    req.end(payload);
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson(port, "GET", "/health");
      if (response.status === 200) return response.body;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("gateway health check timed out");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-gateway-test-"));
  const fakeCli = path.join(root, "fake-agy.mjs");
  const calls = path.join(root, "calls.ndjson");
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) {
  console.log("test-agy 1.2.0");
  process.exit(0);
}
fs.appendFileSync(process.env.TEST_AGY_CALLS, JSON.stringify({argv: process.argv.slice(2), enabledTools: process.env.OPENCLAW_MCP_ENABLED_TOOLS ?? null}) + "\\n");
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", async () => {
  if (input.includes('stall-case')) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return; }
  if (input.includes("queue-delay")) await new Promise(r => setTimeout(r, 1500));
  console.log(JSON.stringify({event:"init",conversation_id:"agy-test-conversation",init:{model:"gemini-3.8-flash"}}));
  if (input.includes("partial-failure")) {
    console.log(JSON.stringify({event:"step_update",step_update:{step_type:"agent_response",text_delta:"unfinished diagnostic prose"}}));
    console.log(JSON.stringify({event:"result",result:{status:"ERROR",error:"fixture interruption",response:"unfinished diagnostic prose"}}));
    process.exitCode=3; return;
  }
  if (input.includes("structured-case")) {
    console.log(JSON.stringify({event:"step_update",step_update:{step_type:"agent_response",text_delta:'{"a":"hello","toolAction":"Completing task"}'}}));
    console.log(JSON.stringify({event:"result", result:{status:"SUCCESS", response:'{"a":"hello","toolAction":"Completing task"}', structured_output:{a:"hello"}, usage:{input_tokens:100,output_tokens:10,thinking_tokens:0,cache_read_tokens:0}}}));
    return;
  }
  if (input.includes("quota-case")) {
    console.log(JSON.stringify({event:"result",result:{status:"ERROR",error:"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h.",response:""}}));
    process.exitCode=3; return;
  }
  if (input.includes("multistep")) {
    const step = (step_index, step_type, extra) => console.log(JSON.stringify({event:"step_update",step_update:{step_index,step_type,state:"DONE",...extra}}));
    step(1, "agent_response", {usage:{input_tokens:13000,cache_read_tokens:81,output_tokens:40,thinking_tokens:30}});
    step(2, "tool", {tool_info:{name:"run_command"}});
    step(3, "agent_response", {text_delta:"done", usage:{input_tokens:2000,cache_read_tokens:20000,output_tokens:60,thinking_tokens:10}});
    console.log(JSON.stringify({event:"result", result:{status:"SUCCESS", response:"done", usage:{input_tokens:15000,cache_read_tokens:20081,output_tokens:100,thinking_tokens:40}}}));
    return;
  }
  console.log(JSON.stringify({event:"step_update",step_update:{step_type:"tool",state:"ERROR",tool_info:{name:"shell",error:{error:"ENOENT",code:2}}}}));
  console.log(JSON.stringify({event:"result", result:{status:"SUCCESS", response:"ok", usage:{input_tokens:"abc",cache_read_tokens:"900",output_tokens:20.7,thinking_tokens:-5}}}));
});
`, { mode: 0o700 });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    env: {
      ...process.env,
      AGY_CLI_BIN: fakeCli,
      AGY_CLI_GATEWAY_PORT: String(port),
      AGY_CLI_GATEWAY_MAX_BODY_MB: "1",
      AGY_CLI_GATEWAY_CWD: root,
      AGY_CLI_GATEWAY_MAX_CONCURRENT: "1",
      AGY_CLI_GATEWAY_STALL_SECONDS: "10",
      AGY_CLI_GATEWAY_HEARTBEAT_SECONDS: "1",
      AGY_CLI_GATEWAY_MAX_PROMPT_BYTES: "10000",
      AGY_CLI_GATEWAY_MAX_PROMPT_CHARS: "20000",
      TEST_AGY_CALLS: calls,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const send = (messages, stream = false) => requestJson(port, "POST", "/v1/chat/completions", {
    model: "gemini-3.8-flash", messages, stream,
  });
  try {
    const health = await waitForHealth(port);
    assert.equal(health.maxPromptBytes, 10000, "byte setting overrides legacy alias");
    assert.equal(health.structuredOutput, true);
    assert.equal(health.permissionMode, "dangerously-skip-permissions");
    const models = await requestJson(port, "GET", "/v1/models");
    assert.deepEqual(models.body.data.map(m => m.id), ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"]);
    assert.deepEqual(models.body.data.at(-1).reasoning_efforts, ["medium"]);
    for (const stream of [false, true]) {
      const rejected = await send([{role:"user",content:"x".repeat(10001)}], stream);
      assert.equal(rejected.status, 413, JSON.stringify(rejected.body));
      assert.match(rejected.body.error.message, /Prompt exceeds.*maximum input size/);
      assert.equal(fs.existsSync(calls), false, "oversized prompts must not launch agy");
    }
    const history = await send([
      {role:"system",content:"s".repeat(6000)},
      {role:"user",content:"u".repeat(6000)},
    ]);
    assert.equal(history.status, 413, "limit must cover the full assembled prompt");
    assert.equal(fs.existsSync(calls), false);
    for (const content of ["中".repeat(4000), "😀".repeat(3000)]) {
      assert.ok(content.length < 10000, "test must be below the old character cap");
      const rejected = await send([{role:"user", content}]);
      assert.equal(rejected.status, 413, "multibyte prompts must use UTF-8 byte size");
      assert.match(rejected.body.error.message, /UTF-8 bytes/);
      assert.equal(fs.existsSync(calls), false);
    }
    const accepted = await send([{role:"user",content:"short request"}]);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.choices[0].message.content, "ok");
    assert.deepEqual(accepted.body.usage, {prompt_tokens:900,prompt_tokens_details:{cached_tokens:900},completion_tokens:20,total_tokens:920});
    const logDeadline=Date.now()+2000;
    while (!stdout.includes('"event":"done"') && Date.now()<logDeadline) await new Promise(resolve=>setTimeout(resolve,10));
    const logs = stdout.split("\n").filter(line => line.includes('"event":')).map(line => JSON.parse(line.slice(line.indexOf("{"))));
    const error = logs.find(row => row.event === "tool_error");
    assert.ok(error, "tool error must be logged");
    assert.equal(logs.find(row=>row.event==="init").conversationId,"agy-test-conversation");
    assert.equal(logs.find(row=>row.event==="done").usageSchema,"agy-output-includes-thinking-v1");
    assert.deepEqual(JSON.parse(error.error), {error:"ENOENT",code:2});
    assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
    const contextUsage = {prompt_tokens:13081,prompt_tokens_details:{cached_tokens:81},completion_tokens:100,total_tokens:13181};
    const multi = await send([{role:"user",content:"multistep request"}]);
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    assert.deepEqual(multi.body.usage, contextUsage, "context comes from the first call, not the summed run");
    const streamed = await requestRaw(port, {model:"gemini-3.8-flash", messages:[{role:"user",content:"multistep streamed"}], stream:true, stream_options:{include_usage:true}});
    const usageChunk = streamed.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(chunk => chunk.usage);
    assert.deepEqual(usageChunk?.usage, contextUsage, "streaming usage chunk matches");
    const doneDeadline=Date.now()+2000;
    while ((stdout.match(/"event":"done"/g) || []).length < 3 && Date.now()<doneDeadline) await new Promise(resolve=>setTimeout(resolve,10));
    const multiDone = stdout.split("\n").filter(line => line.includes('"event":"done"')).map(line => JSON.parse(line.slice(line.indexOf("{")))).at(-1);
    assert.equal(multiDone.usage.prompt_tokens, 35081, "log keeps the billed sum for usage accounting");
    assert.deepEqual(multiDone.usage_reported, contextUsage);
    assert.equal(multiDone.lastCallUsage.cache_read_tokens, 20000);
    const lastCall = () => JSON.parse(fs.readFileSync(calls,'utf8').trim().split('\n').at(-1));
    for (const [model, effort, expectedModelId] of [
      ['gemini-4-argon','low','gemini-4-argon-low'],
      ['gemini-4-argon','medium','gemini-4-argon-medium'],
      ['gemini-4-argon','max','gemini-4-argon-high'],
      ['gemini-3.8-flash','medium','gemini-3.8-flash-medium'],
      ['gemini-3.8-flash','xhigh','gemini-3.8-flash-high'],
      ['gemini-3.8-flash-low',undefined,'gemini-3.8-flash-low'],
      ['claude-sonnet-5-5','off','claude-sonnet-5-5-low'],
      ['gpt-oss-120b','high','gpt-oss-120b-medium'],
      ['gpt-oss-120b',undefined,'gpt-oss-120b-medium'],
    ]) {
      const response=await requestJson(port,'POST','/v1/chat/completions',{model,reasoning_effort:effort,messages:[{role:'user',content:'effort fixture'}]});
      assert.equal(response.status,200, JSON.stringify(response.body));
      const { argv, enabledTools } = lastCall();
      assert.equal(argv[argv.indexOf('--model')+1], expectedModelId, "agy 1.3.3 takes suffixed model ids");
      assert.equal(argv.includes('--effort'), false, "no --effort flag alongside a suffixed id");
      assert.equal(enabledTools, null, "requests without a tools field stay unrestricted");
    }
    assert.equal((await requestJson(port,'POST','/v1/chat/completions',{model:'gemini-3.1-pro',messages:[{role:'user',content:'x'}]})).status,400, "gemini-3.1-pro left the agy catalog");
    // Per-request tool narrowing travels to the MCP proxy via env.
    const narrowed = await requestJson(port,'POST','/v1/chat/completions',{model:'gemini-3.8-flash',tools:[{type:'function',function:{name:'exec'}}],messages:[{role:'user',content:'tools fixture'}]});
    assert.equal(narrowed.status,200);
    assert.equal(lastCall().enabledTools, 'exec');
    const disabled = await requestJson(port,'POST','/v1/chat/completions',{model:'gemini-3.8-flash',tool_choice:'none',messages:[{role:'user',content:'tools fixture'}]});
    assert.equal(disabled.status,200);
    assert.equal(lastCall().enabledTools, '__none__');
    // Structured output: schema flag reaches the CLI and structured_output wins.
    const structured = await requestJson(port,'POST','/v1/chat/completions',{model:'gemini-3.8-flash',response_format:{type:'json_schema',json_schema:{name:'fixture',schema:{type:'object',properties:{a:{type:'string'}}}}},messages:[{role:'user',content:'structured-case'}]});
    assert.equal(structured.status,200, JSON.stringify(structured.body));
    assert.equal(structured.body.choices[0].message.content, '{"a":"hello"}');
    assert.ok(lastCall().argv.includes('--json-schema'));
    const streamedStructured = await requestRaw(port,{model:'gemini-3.8-flash',response_format:{type:'json_object'},messages:[{role:'user',content:'structured-case'}],stream:true});
    const streamedText = streamedStructured.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).map(chunk => chunk.choices?.[0]?.delta?.content || "").join("");
    assert.equal(streamedText, '{"a":"hello"}', "streamed structured output is delivered whole, without toolAction pollution");
    assert.equal((await requestJson(port,'POST','/v1/chat/completions',{model:'gemini-3.8-flash',response_format:{type:'yaml'},messages:[{role:'user',content:'x'}]})).status,400);
    // Quota failures classify as 429 for fast failover.
    const quota = await send([{role:'user',content:'quota-case'}]);
    assert.equal(quota.status, 429, JSON.stringify(quota.body));
    assert.equal(quota.body.error.code, 'AGY_CLI_QUOTA');
    assert.equal((await requestJson(port,'POST','/v1/chat/completions',{model:null,messages:[{role:'user',content:'x'}]})).status,400);
    assert.equal((await requestJson(port,'POST','/v1/chat/completions',{model:'gemini-3.8-flash',reasoning_effort:'typo',messages:[{role:'user',content:'x'}]})).status,400);
    assert.equal((await send([{role:'user',content:'partial-failure'}])).status,502);
    const failedStream=await requestRaw(port,{model:'gemini-3.8-flash',messages:[{role:'user',content:'partial-failure'}],stream:true});
    assert.match(failedStream,/AGY_CLI_ERROR/);
    assert.doesNotMatch(failedStream,/"finish_reason":"stop"/);
    await checkCancelledQueue(port, {model:'gemini-3.8-flash', messages:[{role:'user',content:'queue-delay'}]});
    const stalledAt = Date.now();
    const stalled = await requestRaw(port, {model:'gemini-3.8-flash', messages:[{role:'user',content:'stall-case'}], stream:true});
    assert.match(stalled, /AGY_CLI_STALL/);
    assert.match(stalled, /gateway heartbeat/, "SSE heartbeat must not hide a CLI stall");
    assert.ok(Date.now() - stalledAt < 19000, 'stall cleanup must not wait forever for close');
    assert.equal((await send([{role:'user',content:'recovered'}])).status, 200);
    const tooLarge = await send([{role:'user',content:'x'.repeat(1100000)}]);
    assert.equal(tooLarge.status, 413);
    console.log("antigravity gateway integration: UTF-8 limit, Chinese/emoji, streaming rejection, full history, normal request and first-call context usage ok");
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000).unref();
    });
    fs.rmSync(root, { recursive:true, force:true });
  }
  assert.equal(stderr, "", stderr);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
