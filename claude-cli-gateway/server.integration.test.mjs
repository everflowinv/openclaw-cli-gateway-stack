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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-gateway-test-"));
  const fakeClaude = path.join(root, "fake-claude.mjs");
  fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("test-claude 1.0\\n");
  process.exit(0);
}
let input="";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  if (input.includes('stall-case')) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return; }
  if (input.includes('failure-hang-case')) {
    console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'fixture failed'}));
    setInterval(()=>{},1000); return;
  }
  if (input.includes('partial-usage-case')) {
    const message={id:'partial-usage',model:'claude-opus-5-5',usage:{input_tokens:10,cache_read_input_tokens:30,cache_creation_input_tokens:20,output_tokens:1}};
    console.log(JSON.stringify({type:'stream_event',event:{type:'message_start',message}}));
    console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool-1',name:'read',input:{}}}}));
    console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"path":"fixture"}'}}}));
    console.log(JSON.stringify({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:150}}}));
    console.log(JSON.stringify({type:'assistant',message}));
    console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'FIXTURE_OUTPUT'}]}}));
    console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'fixture interruption'}));
    return;
  }
  if (input.includes('too-long-case')) {
    console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'Prompt is too long · the request is ~1071529 tokens (limit 1000000)'}));
    return;
  }
  if (input.includes('quota-case')) {
    console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'You have hit your usage limit; try again later'}));
    return;
  }
  const progress = input.includes('progress-case') ? setInterval(()=>console.log('{}'),400) : null;
  setTimeout(() => {
    clearInterval(progress);
    console.log(JSON.stringify({type:"assistant",message:{id:"msg-usage-fixture",model:"claude-opus-5-5",usage:{input_tokens:10,cache_creation_input_tokens:4000,cache_read_input_tokens:900,output_tokens:2}}}));
    console.log(JSON.stringify({type:"assistant",message:{id:"msg-usage-fixture-2",model:"claude-opus-5-5",usage:{input_tokens:5,cache_creation_input_tokens:300,cache_read_input_tokens:4900,output_tokens:18}}}));
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: input.includes('effort-case') ? JSON.stringify({effort:process.argv[process.argv.indexOf('--effort')+1],envEffort:process.env.CLAUDE_CODE_EFFORT_LEVEL})
        : input.includes('args-case') ? JSON.stringify({argv:process.argv.slice(2),enabledTools:process.env.OPENCLAW_MCP_ENABLED_TOOLS??null})
        : input.includes('structured-case') ? '{"a":"hello","extra":1}' : "ok",
      ...(input.includes('structured-case') ? {structured_output:{a:"hello"}} : {}),
      usage: { input_tokens: "15", cache_read_input_tokens: "5800", cache_creation_input_tokens: 4300, output_tokens: 20.7 },
    }) + "\\n");
  }, (input.includes("effort-case") || input.includes("args-case") || input.includes("structured-case")) ? 5 : input.includes("progress-case") ? 11500 : 1800);
});
`, "utf8");
  fs.chmodSync(fakeClaude, 0o700);

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    env: {
      ...process.env,
      CLAUDE_CLI_BIN: fakeClaude,
      CLAUDE_CODE_EFFORT_LEVEL: "high",
      CLAUDE_CLI_GATEWAY_PORT: String(port),
      CLAUDE_CLI_GATEWAY_MAX_BODY_MB: "1",
      CLAUDE_CLI_GATEWAY_MAX_CONCURRENT: "1",
      CLAUDE_CLI_GATEWAY_QUEUE_TIMEOUT_SECONDS: "1",
      CLAUDE_CLI_GATEWAY_TIMEOUT_SECONDS: "30",
      CLAUDE_CLI_GATEWAY_STALL_SECONDS: "10",
      CLAUDE_CLI_GATEWAY_HEARTBEAT_IDLE_SECONDS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  const requestBody = {
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: "queue test" }],
    stream: false,
  };

  try {
    const health = await waitForHealth(port);
    assert.equal(health.maxConcurrent, 1);
    assert.equal(health.queueTimeoutSeconds, 1);
    assert.equal(health.structuredOutput, true);
    assert.equal(health.permissionMode, "dangerously-skip-permissions");
    assert.equal(health.autocompact, "1000000");

    const first = requestJson(port, "POST", "/v1/chat/completions", requestBody);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const queuedAt = Date.now();
    const second = await requestJson(port, "POST", "/v1/chat/completions", requestBody);
    const queuedFor = Date.now() - queuedAt;
    assert.equal(second.status, 503, JSON.stringify(second.body));
    assert.equal(second.body.error.code, "CLAUDE_CLI_QUEUE_TIMEOUT");
    assert.ok(queuedFor >= 900 && queuedFor < 2500, `unexpected queue wait: ${queuedFor}ms`);

    const completed = await first;
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.choices[0].message.content, "ok");
    // First call's full prompt (10 + 4000 + 900), not the 2-call sum.
    const contextUsage = {prompt_tokens:4910, prompt_tokens_details:{cached_tokens:900, cache_write_tokens:4000}, completion_tokens:20, total_tokens:4930};
    assert.deepEqual(completed.body.usage, contextUsage);
    const doneEvents = () => stdout.split("\n").filter((line) => line.startsWith("[CLIGW] ") && line.includes('"event":"done"')).map((line) => JSON.parse(line.slice(8)));
    // The done line is written right after the response; allow it to flush.
    for (let i = 0; i < 40 && doneEvents().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    const [done] = doneEvents();
    // Billing totals in the log keep their shape for model-usage-cost.
    assert.deepEqual(done.usage, {prompt_tokens:5815, prompt_tokens_details:{cached_tokens:5800}, cache_creation_input_tokens:4300, completion_tokens:20, total_tokens:10135});
    assert.deepEqual(done.usage_reported, contextUsage);
    assert.equal(done.lastCallUsage.prompt_tokens, 4905);

    const streamed = await requestJson(port, "POST", "/v1/chat/completions", {...requestBody, stream: true, stream_options: {include_usage: true}});
    assert.equal(streamed.status, 200);
    const chunks = String(streamed.body).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(chunks.find((chunk) => chunk.usage)?.usage, contextUsage);
    assert.match(stdout, /"event":"usage"/);
    assert.match(stdout, /"messageId":"msg-usage-fixture"/);
    assert.match(stdout, /"requestUuid":"[a-f0-9-]{36}"/);
    assert.match(stdout, /"event":"queued"/);
    assert.match(stdout, /"event":"queue_timeout"/);
    for (const [requested, expected] of [['off','low'],['none','low'],['minimal','low'],['low','low'],['medium','medium'],['high','high'],['xhigh','xhigh'],['max','max'],['ultra','max']]) {
      const result = await requestJson(port, 'POST', '/v1/chat/completions', { ...requestBody, reasoning_effort: requested, messages:[{role:'user',content:'effort-case'}] });
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.body.choices[0].message.content), {effort:expected,envEffort:expected});
    }
    // Maximum-permission posture + request-shaped tool surface.
    const argsOf = async (extra) => {
      const r = await requestJson(port, 'POST', '/v1/chat/completions', { ...requestBody, messages: [{ role: 'user', content: 'args-case' }], ...extra });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return JSON.parse(r.body.choices[0].message.content);
    };
    const unrestricted = await argsOf({});
    assert.ok(unrestricted.argv.includes('--dangerously-skip-permissions'));
    assert.equal(unrestricted.argv[unrestricted.argv.indexOf('--autocompact') + 1], '1000000');
    assert.equal(unrestricted.argv.includes('--tools'), false, 'unrestricted runs keep the full native tool set');
    assert.ok(unrestricted.argv.includes('--mcp-config'));
    assert.equal(unrestricted.enabledTools, null);
    const narrowed = await argsOf({ tools: [{ type: 'function', function: { name: 'exec' } }] });
    assert.equal(narrowed.argv[narrowed.argv.indexOf('--tools') + 1], 'ToolSearch', 'an explicit tools list bounds the run to the MCP bridge');
    assert.equal(narrowed.enabledTools, 'exec');
    const disabled = await argsOf({ tool_choice: 'none' });
    assert.equal(disabled.argv[disabled.argv.indexOf('--tools') + 1], '', 'tool_choice none disables built-in tools');
    assert.equal(disabled.argv.includes('--mcp-config'), false, 'tool_choice none omits the MCP bridge');
    const withSchema = await argsOf({ response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } } });
    assert.ok(withSchema.argv.includes('--json-schema'));
    // Structured output returns the schema-shaped value, not surrounding prose.
    const structured = await requestJson(port, 'POST', '/v1/chat/completions', { ...requestBody, messages: [{ role: 'user', content: 'structured-case' }], response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', properties: { a: { type: 'string' } } } } } });
    assert.equal(structured.status, 200);
    assert.equal(structured.body.choices[0].message.content, '{"a":"hello"}');
    const partial = await requestJson(port, 'POST', '/v1/chat/completions', { ...requestBody, messages:[{role:'user',content:'partial-usage-case'}] });
    assert.equal(partial.status, 502);
    const usageEvents = stdout.split('\n').filter(line => line.startsWith('[CLIGW] ')).map(line => JSON.parse(line.slice(8)));
    const partialUsage = usageEvents.filter(e => e.messageId === 'partial-usage');
    assert.equal(partialUsage.length, 2);
    assert.equal(partialUsage.at(-1).usage.completion_tokens, 150);
    assert.equal(partialUsage.at(-1).usageComplete, true);
    assert.ok(usageEvents.some(e => e.event === 'tool_args' && e.toolUseId === 'tool-1'));
    assert.ok(usageEvents.some(e => e.event === 'tool_done' && e.output === 'FIXTURE_OUTPUT'));
    // Terminal failures classify like a normal provider.
    const tooLong = await requestJson(port, 'POST', '/v1/chat/completions', { ...requestBody, messages: [{ role: 'user', content: 'too-long-case' }] });
    assert.equal(tooLong.status, 413, JSON.stringify(tooLong.body));
    assert.equal(tooLong.body.error.code, 'CLAUDE_CLI_CONTEXT_TOO_LONG');
    assert.match(tooLong.body.error.message, /Prompt is too long/);
    const quota = await requestJson(port, 'POST', '/v1/chat/completions', { ...requestBody, messages: [{ role: 'user', content: 'quota-case' }] });
    assert.equal(quota.status, 429, JSON.stringify(quota.body));
    assert.equal(quota.body.error.code, 'CLAUDE_CLI_QUOTA');
    await checkCancelledQueue(port, requestBody);
    for (const [content, expected] of [['failure-hang-case','CLAUDE_CLI_ERROR'], ['stall-case','CLAUDE_CLI_STALL']]) {
      const start = Date.now();
      const failed = await requestJson(port, 'POST', '/v1/chat/completions', {...requestBody, messages:[{role:'user',content}], stream:true});
      assert.match(String(failed.body), new RegExp(expected));
      if (content === 'stall-case') assert.match(String(failed.body), /gateway heartbeat/, 'SSE heartbeat must not hide a CLI stall');
      assert.ok(Date.now() - start < 19000, 'cleanup must have a bounded deadline');
      assert.equal((await waitForHealth(port)).activeRequests, 0);
      assert.equal((await requestJson(port, 'POST', '/v1/chat/completions', {...requestBody, messages:[{role:'user',content:'effort-case'}]})).status, 200);
    }
    assert.equal((await requestJson(port, 'POST', '/v1/chat/completions', {...requestBody, messages:[{role:'user',content:'progress-case'}]})).status, 200, 'real stdout must refresh the stall timer');
    const tooLarge = await requestJson(port, 'POST', '/v1/chat/completions', { ...requestBody, messages: [{role:'user', content:'x'.repeat(1100000)}] });
    assert.equal(tooLarge.status, 413);
    process.stdout.write("claude-cli gateway integration: queue timeout and first-call context usage ok\n");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    });
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(stderr, "", stderr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
