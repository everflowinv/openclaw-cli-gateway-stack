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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-gateway-test-"));
  const fakeCli = path.join(root, "fake-agy.mjs");
  const calls = path.join(root, "calls.ndjson");
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) {
  console.log("test-agy 1.2.0");
  process.exit(0);
}
fs.appendFileSync(process.env.TEST_AGY_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({event:"init",conversation_id:"agy-test-conversation",init:{model:"gemini-3.8-flash"}}));
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
      AGY_CLI_GATEWAY_CWD: root,
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
    console.log("antigravity gateway integration: UTF-8 limit, Chinese/emoji, streaming rejection, full history and normal request ok");
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
