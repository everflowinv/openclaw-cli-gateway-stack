"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { producerPreview } = require("./continuation-full-reply");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-continuation-integration-"));
  const workspace = path.join(root, "workspace");
  const desktop = path.join(workspace, ".eve-desktop");
  const dbPath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
  const fakeCli = path.join(root, "fake-cli");
  const cliLog = path.join(root, "cli-calls.jsonl");
  const waitFile = path.join(root, "wait-response.json");
  const sessionKey = "agent:main:codex-desktop-lumos";
  const sessionId = "11111111-2222-4333-8444-555555555555";
  fs.mkdirSync(desktop, { recursive: true, mode: 0o700 });
  fs.chmodSync(desktop, 0o700);
  fs.mkdirSync(path.join(desktop, "session-allowlist"), { mode: 0o700 });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // No real service or credentials: every CLI command is pinned to fakeCli.
  fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ gateway: { port: 1, auth: { mode: "token", token: "offline-test-only" } } }));
  fs.writeFileSync(waitFile, "{}");
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = (data) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ ...data, pid: process.pid }) + '\\n');
if (args[0] === 'agent') {
  const message = args[args.indexOf('--message') + 1];
  log({ method: 'agent', message });
  process.stdout.write(JSON.stringify({ runId: 'root-' + message, status: 'ok', result: {
    meta: { yielded: true, context: 'PRIVATE-YIELD' }, payloads: [{ text: 'PRIVATE-YIELD' }]
  } }) + '\\n');
} else if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'agent.wait') {
  const params = JSON.parse(args[args.indexOf('--params') + 1]);
  log({ method: 'agent.wait', params });
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_WAIT_FILE, 'utf8'));
  if (state.hang) {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else {
    const response = state.response || { runId: params.runId, status: 'timeout' };
    setTimeout(() => process.stdout.write(JSON.stringify(response) + '\\n'), state.delayMs || 0);
  }
} else { log({ method: 'UNEXPECTED', args }); process.exitCode = 2; }
`, { mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  // Match the live OpenClaw store: the proxy reads while completions append.
  // Rollback-journal mode spuriously locks the writer during those reads.
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT);
    CREATE TABLE session_transcript_index_state(session_id TEXT PRIMARY KEY, needs_rebuild INTEGER);
    CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT);
    CREATE TABLE session_transcript_active_events(session_id TEXT, active_position INTEGER, event_seq INTEGER, message_position INTEGER);
  `);
  db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(sessionKey, sessionId);
  db.prepare("INSERT INTO session_transcript_index_state VALUES (?, 0)").run(sessionId);
  let seq = 0;
  const append = (message) => {
    const entry = { id: `event-${seq}`, type: "message", timestamp: new Date().toISOString(), message };
    db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(sessionId, seq, JSON.stringify(entry));
    db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run(sessionId, seq, seq, seq);
    seq++;
  };
  const prepare = (label, withWake = true, sourceOverride) => {
    const childKey = `agent:main:subagent:child-${label}`;
    const childRun = `child-run-${label}`;
    const continuation = `announce:requester-settle:main:${sessionKey}:${childRun}:yield-1`;
    append({ role: "user", content: label, idempotencyKey: `root-${label}:user` });
    append({ role: "assistant", content: [{ type: "toolCall", id: `spawn-${label}`, name: "sessions_spawn", arguments: { runtime: "subagent", task: "PRIVATE-TASK" } }] });
    append({ role: "toolResult", toolCallId: `spawn-${label}`, toolName: "sessions_spawn", content: [{ type: "text", text: JSON.stringify({ status: "accepted", childSessionKey: childKey, runId: childRun, expectsCompletionMessage: true }) }] });
    append({ role: "assistant", content: [{ type: "toolCall", id: `yield-${label}`, name: "sessions_yield", arguments: { message: "PRIVATE-YIELD" } }] });
    const addWake = () => append({ role: "user", idempotencyKey: `${continuation}:user`, content: "PRIVATE-CHILD-RESULT",
      provenance: { kind: "inter_session", sourceTool: "subagent_announce", sourceChannel: "internal", sourceSessionKey: sourceOverride || childKey } });
    if (withWake) addWake();
    return { continuation, addWake };
  };
  const logs = () => fs.existsSync(cliLog) ? fs.readFileSync(cliLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { PATH: process.env.PATH, HOME: root,
      OPENCLAW_HOME: root, OPENCLAW_WORKSPACE: workspace, OPENCLAW_CLI: fakeCli,
      OPENCLAW_MCP_DYNAMIC_SESSIONS: "1", OPENCLAW_MCP_ENABLED_TOOLS: "sessions_start,sessions_send",
      OPENCLAW_REQUESTER_SESSION_KEY: sessionKey, FAKE_LOG: cliLog, FAKE_WAIT_FILE: waitFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => { stderr += b; });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const cb = pending.get(response.id);
    if (cb) { pending.delete(response.id); cb(response); }
  });
  let requestId = 1;
  const send = (message) => new Promise((resolve) => {
    const id = requestId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
      name: "sessions_send", arguments: { sessionKey, message, timeoutSeconds: 1 },
    } }) + "\n");
  });
  const terminal = (runId, disposition = "visible") => ({ runId, status: "ok", endedAt: Date.now(),
    stopReason: "end_turn", terminalReceipt: { runId, sessionId },
    terminalReply: disposition === "visible" ? { disposition, text: "parent-final [[EVE_ATTACHMENT:{}]]" } : { disposition } });
  try {
    const first = prepare("completed", false);
    const completionPromise = send("completed");
    const timer = setTimeout(() => {
      first.addWake();
      append({ role: "assistant", content: "PRIVATE raw progress, not a final receipt" });
      fs.writeFileSync(waitFile, JSON.stringify({ response: terminal(first.continuation) }));
    }, 200);
    const completed = await completionPromise;
    clearTimeout(timer);
    assert.equal(completed.result.isError, false, stderr + JSON.stringify(completed));
    assert.equal(completed.result.structuredContent.runId, "root-completed");
    assert.equal(completed.result.structuredContent.continuationRunId, first.continuation);
    assert.equal(completed.result.structuredContent.reply, "parent-final [[EVE_ATTACHMENT:{}]]");
    assert.equal(completed.result.structuredContent.delivery.status, "returned");
    assert.equal(completed.result.structuredContent.delivery.mode, "mcp");
    assert.equal(completed.result.structuredContent.replySource, "native_terminal_snapshot");
    assert.ok(!JSON.stringify(completed).includes("PRIVATE"));
    assert.ok(logs().filter((l) => l.method === "agent.wait").every((l) => l.params.runId === first.continuation));
    assert.equal(logs().filter((l) => l.method === "agent").length, 1);

    // The same restricted MCP call must transport full long finals, not merely
    // the 4096-character agent.wait preview; verify exact bytes and attachment tail.
    for (const size of [10000, 400000, 450000]) {
      const long = prepare("long-" + size);
      const tail = '[[EVE_ATTACHMENT:{"path":"/synthetic/long-test.md"}]]';
      const full = "汉".repeat(size - tail.length) + tail;
      append({role:"assistant",provider:"openai",stopReason:"stop",__openclaw:{runId:long.continuation},
        content:[{type:"thinking",thinking:"PRIVATE-REASONING"},
          {type:"text",text:full,textSignature:JSON.stringify({phase:"final_answer"})}]});
      const receipt = terminal(long.continuation);
      receipt.terminalReply.text = producerPreview(full);
      fs.writeFileSync(waitFile, JSON.stringify({response:receipt}));
      const result = (await send("long-" + size)).result.structuredContent;
      assert.equal(result.status,"ok");
      assert.equal(result.replySource,"verified_continuation_transcript");
      assert.equal(result.replyLimitChars,400000);
      assert.equal(result.replyOriginalChars,size);
      assert.ok(result.reply.endsWith(tail));
      assert.ok(!result.reply.includes("PRIVATE"));
      if (size <= 400000) { assert.equal(result.reply,full); assert.equal(result.replyTruncated,false); }
      else { assert.ok(result.reply.length<=400000); assert.equal(result.replyTruncated,true); }
      assert.equal(logs().filter((l)=>l.method==='agent' && l.message==='long-'+size).length,1);
    }

    const empty = prepare("empty");
    fs.writeFileSync(waitFile, JSON.stringify({ response: terminal(empty.continuation, "empty") }));
    const emptyResult = await send("empty");
    assert.equal(emptyResult.result.isError, true);
    assert.equal(emptyResult.result.structuredContent.status, "empty");
    assert.equal(emptyResult.result.structuredContent.reply, undefined);

    const raced = prepare("raced");
    fs.writeFileSync(waitFile, JSON.stringify({ delayMs: 500, response: terminal(raced.continuation) }));
    const racedPromise = send("raced");
    const boundaryTimer = setTimeout(() => append({ role: "user", content: "new external request", idempotencyKey: "new-request:user" }), 250);
    const racedResult = await racedPromise;
    clearTimeout(boundaryTimer);
    assert.equal(racedResult.result.isError, true);
    assert.equal(racedResult.result.structuredContent.status, "superseded");
    assert.equal(racedResult.result.structuredContent.reply, undefined);

    prepare("unrelated", true, "agent:main:subagent:unrelated");
    const unrelated = await send("unrelated");
    assert.equal(unrelated.result.structuredContent.code, "DIRECT_AGENT_UNRELATED_INPUT");

    const hanging = prepare("hanging");
    fs.writeFileSync(waitFile, JSON.stringify({ hang: true }));
    const started = Date.now();
    const timedOut = await send("hanging");
    const elapsed = Date.now() - started;
    assert.equal(timedOut.result.isError, true);
    assert.ok(["yielded", "timeout"].includes(timedOut.result.structuredContent.status));
    assert.ok(["DIRECT_AGENT_WAIT_UNAVAILABLE", "DIRECT_AGENT_CONTINUATION_TIMEOUT"].includes(timedOut.result.structuredContent.code));
    assert.equal(timedOut.result.structuredContent.runId, "root-hanging");
    assert.equal(timedOut.result.structuredContent.sentBeforeError, true);
    assert.equal(timedOut.result.structuredContent.reply, undefined);
    assert.ok(elapsed >= 14000 && elapsed < 33000, `observer must fail within its RPC or original call budget: ${elapsed}ms`);
    const hangingCalls = logs().filter((l) => l.method === "agent.wait" && l.params.runId === hanging.continuation);
    // Each RPC has its own bounded wait; an unresponsive observer fails closed
    // rather than being allowed to extend the original invocation indefinitely.
    assert.ok(hangingCalls.length >= 1);
    assert.equal(logs().filter((l) => l.method === "agent" && l.message === "hanging").length, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const call of hangingCalls) assert.throws(() => process.kill(call.pid, 0), /ESRCH/, "observer CLI leaked after deadline");
    assert.ok(!logs().some((l) => l.method === "UNEXPECTED"));
    const diagnostics = fs.readFileSync(path.join(desktop, "logs/text-proxy.jsonl"), "utf8");
    assert.ok(!diagnostics.includes("PRIVATE"));
    assert.ok(!diagnostics.split("\n").filter(Boolean).map(JSON.parse).some((l) => l.event === "sessions_send_ok" && l.replyChars === 0));
    console.log("continuation integration: 10000/400000 full text, 450000 capped with tail, persisted spawn/batch/provenance + exact final, empty, external boundary, no resend, deadline and observer cleanup ok");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
