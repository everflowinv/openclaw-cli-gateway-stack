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
  setTimeout(() => {
    console.log(JSON.stringify({type:"assistant",message:{id:"msg-usage-fixture",model:"claude-opus-5-5",usage:{input_tokens:10,cache_creation_input_tokens:4000,cache_read_input_tokens:900,output_tokens:2}}}));
    console.log(JSON.stringify({type:"assistant",message:{id:"msg-usage-fixture-2",model:"claude-opus-5-5",usage:{input_tokens:5,cache_creation_input_tokens:300,cache_read_input_tokens:4900,output_tokens:18}}}));
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: input.includes('effort-case') ? JSON.stringify({effort:process.argv[process.argv.indexOf('--effort')+1],envEffort:process.env.CLAUDE_CODE_EFFORT_LEVEL}) : "ok",
      usage: { input_tokens: "15", cache_read_input_tokens: "5800", cache_creation_input_tokens: 4300, output_tokens: 20.7 },
    }) + "\\n");
  }, input.includes("effort-case") ? 5 : 1800);
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
    await checkCancelledQueue(port, requestBody);
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
