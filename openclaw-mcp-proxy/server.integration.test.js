"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mcp-proxy-test-"));
  const requester = "agent:main:discord:direct:integration-test";
  const calls = [];
  const fakeGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(call);
      if (call.args?.integrationHang === true) return;
      const payload = JSON.stringify({ ok: true, result: { active: [], recent: [] } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });

  await new Promise((resolve) => fakeGateway.listen(0, "127.0.0.1", resolve));
  const port = fakeGateway.address().port;
  fs.mkdirSync(path.join(root, "workspace", "temp"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({ gateway: { port, auth: { mode: "token", token: "test-token" } } }),
    "utf8"
  );
  const desktopRoot = path.join(root, "workspace", ".eve-desktop");
  const allowlistRoot = path.join(desktopRoot, "session-allowlist");
  fs.mkdirSync(allowlistRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(desktopRoot, 0o700);
  fs.chmodSync(allowlistRoot, 0o700);
  const fakeCreateLog = path.join(root, "sessions-create.log");
  const fakeAgentLog = path.join(root, "direct-agent.log");
  const fakeCli = path.join(root, "bin", "openclaw");
  fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
  fs.writeFileSync(
    fakeCli,
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "agent") {
  const sessionKey = args[args.indexOf("--session-key") + 1];
  const message = args[args.indexOf("--message") + 1];
  const timeout = args[args.indexOf("--timeout") + 1];
  fs.appendFileSync(process.env.FAKE_DIRECT_AGENT_LOG, JSON.stringify({ sessionKey, message, timeout }) + "\\n");
  if (message === "deadline-hang") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (message === "interrupted-test") {
    process.stdout.write(JSON.stringify({ runId: "fake-run:" + message, status: "ok",
      result: { payloads: [{ text: "stale progress must not become final" }], meta: { aborted: true } },
    }) + "\\n");
    process.exit(0);
  }
  if (message.startsWith("yield-") || ["empty-test", "silent-test"].includes(message)) {
    const yielded = message.startsWith("yield-");
    process.stdout.write(JSON.stringify({
      runId: "fake-run:" + message,
      status: "ok",
      result: {
        payloads: yielded ? [{ text: "PRIVATE-YIELD-CONTEXT" }] : [],
        meta: yielded ? { yielded: true, context: "PRIVATE-YIELD-CONTEXT" }
          : { terminalReply: { disposition: message === "silent-test" ? "silent" : "empty" } },
      },
    }) + "\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    runId: "fake-run:" + message,
    status: "ok",
    result: { payloads: [{ text: "direct:" + message }] },
  }) + "\\n");
  process.exit(0);
}
const callIndex = args.indexOf("call");
const paramsIndex = args.indexOf("--params");
const method = callIndex >= 0 ? args[callIndex + 1] : "";
const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : {};
if (method === "agent.wait") {
  process.stdout.write(JSON.stringify({runId:params.runId,status:"ok",endedAt:Date.now(),
    terminalReceipt:{runId:params.runId,sessionId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"},
    terminalReply:{disposition:"visible",text:"later-parent-final"}}) + "\\n");
  process.exit(0);
}
if (method !== "sessions.create") {
  process.stderr.write("unexpected method: " + method + "\\n");
  process.exit(2);
}
fs.appendFileSync(process.env.FAKE_GATEWAY_CREATE_LOG, JSON.stringify({ method, params }) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, key: params.key, sessionId: "fake-session" }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeCli, 0o700);

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      OPENCLAW_HOME: root,
      OPENCLAW_CLI: fakeCli,
      OPENCLAW_WORKSPACE: path.join(root, "workspace"),
      OPENCLAW_REQUESTER_SESSION_KEY: requester,
      OPENCLAW_MCP_GATEWAY_TOOL_TIMEOUT_MS: "100",
      OPENCLAW_MCP_LOCAL_TOOL_TIMEOUT_MS: "100",
      OPENCLAW_MCP_LOCAL_TOOL_KILL_GRACE_MS: "50",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });

  function rpc(id, method, params) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }) + "\n");
    });
  }

  function request(id, name, args) {
    return rpc(id, "tools/call", { name, arguments: args });
  }

  try {
    const toolList = await rpc(10, "tools/list", {});
    const message = toolList.result.tools.find((tool) => tool.name === "message");
    const spawnTool = toolList.result.tools.find((tool) => tool.name === "sessions_spawn");
    const execTool = toolList.result.tools.find((tool) => tool.name === "exec");
    assert.ok(message.inputSchema.properties.to);
    assert.ok(message.inputSchema.properties.filePath);
    assert.ok(message.inputSchema.properties.components);
    assert.deepStrictEqual(spawnTool.inputSchema.properties.mode.enum, ["run", "session"]);
    assert.strictEqual(spawnTool.inputSchema.properties.thread.type, "boolean");
    assert.match(execTool.description, /Do not use shell backgrounding/);
    assert.strictEqual(execTool.inputSchema.properties.timeoutMs.type, "number");

    const timeoutStartedAt = Date.now();
    const timedOut = await request(11, "exec", { command: "sleep 5" });
    assert.strictEqual(timedOut.result.isError, true, stderr);
    assert.match(timedOut.result.content[0].text, /timed out after 100ms/);
    assert.ok(Date.now() - timeoutStartedAt < 2000);

    const marker = path.join(root, "background-process-marker");
    const background = await request(12, "process", {
      action: "start",
      command: `sleep 1; printf done > ${JSON.stringify(marker)}`,
    });
    assert.strictEqual(background.result.isError, false, stderr);
    const backgroundSession = JSON.parse(background.result.content[0].text).sessionId;
    const stopped = await request(13, "process", { action: "kill", sessionId: backgroundSession });
    assert.strictEqual(stopped.result.isError, false, stderr);
    assert.match(stopped.result.content[0].text, /stopping|removed/);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.strictEqual(fs.existsSync(marker), false, "process kill left a child running");

    const listed = await request(1, "subagents", { action: "list" });
    assert.strictEqual(listed.result.isError, false, stderr);
    assert.strictEqual(calls[0].sessionKey, requester);
    assert.strictEqual(calls[0].args.sessionKey, undefined);
    assert.strictEqual(calls[0].agentId, undefined, "agent-scoped requester must retain its own owner");

    const yielded = await request(2, "sessions_yield", { timeoutMs: 100 });
    assert.strictEqual(yielded.result.isError, false, stderr);
    assert.strictEqual(calls[1].sessionKey, requester);
    assert.match(yielded.result.content[0].text, /no_pending_subagent/);

    const gatewayTimeoutStartedAt = Date.now();
    const gatewayTimedOut = await request(14, "subagents", {
      action: "list",
      integrationHang: true,
    });
    assert.strictEqual(gatewayTimedOut.result.isError, true, stderr);
    assert.match(gatewayTimedOut.result.content[0].text, /Gateway request timed out after 100ms/);
    assert.ok(Date.now() - gatewayTimeoutStartedAt < 2000);

    const unscoped = await request(150, "subagents", { action: "list", sessionKey: "legacy-upgrade-test" });
    assert.strictEqual(unscoped.result.isError, false, stderr);
    assert.strictEqual(calls.at(-1).agentId, "main", "unscoped request requires explicit owner");
    assert.strictEqual(calls.at(-1).sessionKey, "legacy-upgrade-test");
    const otherAgent = await request(151, "subagents", { action: "list", sessionKey: "agent:marco:main" });
    assert.strictEqual(otherAgent.result.isError, false, stderr);
    assert.strictEqual(calls.at(-1).agentId, undefined, "main fallback must not override another agent");
    assert.strictEqual(calls.at(-1).sessionKey, "agent:marco:main");

    const restrictedTarget = "agent:main:codex-desktop-lumos";
    const restrictedChild = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: {
        ...process.env,
        OPENCLAW_HOME: root,
        OPENCLAW_CLI: fakeCli,
        OPENCLAW_WORKSPACE: path.join(root, "workspace"),
        OPENCLAW_MCP_DYNAMIC_SESSIONS: "1",
        OPENCLAW_MCP_ENABLED_TOOLS: "sessions_start,sessions_send",
        OPENCLAW_REQUESTER_SESSION_KEY: restrictedTarget,
        FAKE_GATEWAY_CREATE_LOG: fakeCreateLog,
        FAKE_DIRECT_AGENT_LOG: fakeAgentLog,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let restrictedStderr = "";
    restrictedChild.stderr.on("data", (chunk) => { restrictedStderr += chunk.toString("utf8"); });
    const restrictedLines = readline.createInterface({ input: restrictedChild.stdout });
    const restrictedPending = new Map();
    restrictedLines.on("line", (line) => {
      const message = JSON.parse(line);
      const resolve = restrictedPending.get(message.id);
      if (resolve) {
        restrictedPending.delete(message.id);
        resolve(message);
      }
    });
    function restrictedRpc(id, method, params) {
      return new Promise((resolve) => {
        restrictedPending.set(id, resolve);
        restrictedChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    try {
      const restrictedTools = await restrictedRpc(20, "tools/list", {});
      assert.deepStrictEqual(
        restrictedTools.result.tools.map((tool) => tool.name),
        ["sessions_start", "sessions_send"]
      );
      const restrictedSendTool = restrictedTools.result.tools.find(
        (tool) => tool.name === "sessions_send"
      );
      assert.strictEqual(
        restrictedSendTool.inputSchema.properties.timeoutSeconds.maximum,
        3600
      );

      const startedOne = await restrictedRpc(21, "tools/call", {
        name: "sessions_start",
        arguments: {},
      });
      const startedTwo = await restrictedRpc(22, "tools/call", {
        name: "sessions_start",
        arguments: {},
      });
      assert.strictEqual(startedOne.result.isError, false, JSON.stringify(startedOne) + restrictedStderr);
      assert.strictEqual(startedTwo.result.isError, false, restrictedStderr);
      const keyOne = startedOne.result.structuredContent.sessionKey;
      const keyTwo = startedTwo.result.structuredContent.sessionKey;
      const dynamicKeyRe = /^agent:main:codex-desktop-lumos-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
      assert.match(keyOne, dynamicKeyRe);
      assert.match(keyTwo, dynamicKeyRe);
      assert.notStrictEqual(keyOne, keyTwo);
      for (const key of [keyOne, keyTwo]) {
        const uuid = dynamicKeyRe.exec(key)[1];
        const registrationPath = path.join(allowlistRoot, uuid);
        assert.strictEqual(fs.readFileSync(registrationPath, "utf8"), key + "\n");
        assert.strictEqual(fs.statSync(registrationPath).mode & 0o777, 0o600);
      }
      const createCalls = fs.readFileSync(fakeCreateLog, "utf8").trim().split("\n").map(JSON.parse);
      assert.deepStrictEqual(createCalls.map((entry) => entry.method), ["sessions.create", "sessions.create"]);
      assert.deepStrictEqual(createCalls.map((entry) => entry.params.agentId), ["main", "main"]);
      assert.deepStrictEqual(createCalls.map((entry) => entry.params.key), [keyOne, keyTwo]);

      const firstAllowed = await restrictedRpc(23, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: keyOne, message: "allowed-one", timeoutSeconds: 3600 },
      });
      assert.strictEqual(firstAllowed.result.isError, false, restrictedStderr);
      const firstAllowedResult = JSON.parse(firstAllowed.result.content[0].text);
      assert.strictEqual(firstAllowedResult.reply, "direct:allowed-one");
      assert.deepStrictEqual(firstAllowedResult.delivery, { status: "returned", mode: "mcp", externalDelivery: "unverified" });
      assert.strictEqual(firstAllowedResult.runId, "fake-run:allowed-one");
      assert.match(firstAllowedResult.requestId, /^[0-9a-f-]{36}$/);

      const secondAllowed = await restrictedRpc(24, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: keyTwo, message: "allowed-two" },
      });
      assert.strictEqual(secondAllowed.result.isError, false, restrictedStderr);

      const legacyAllowed = await restrictedRpc(25, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: restrictedTarget, message: "legacy-allowed" },
      });
      assert.strictEqual(legacyAllowed.result.isError, false, restrictedStderr);
      const directCalls = fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").map(JSON.parse);
      assert.deepStrictEqual(directCalls, [
        { sessionKey: keyOne, message: "allowed-one", timeout: "3600" },
        { sessionKey: keyTwo, message: "allowed-two", timeout: "600" },
        { sessionKey: restrictedTarget, message: "legacy-allowed", timeout: "600" },
      ]);
      assert.ok(directCalls.every((entry) => !entry.message.includes("sourceTool=sessions_send")));

      const callsBeforeDenied = directCalls.length;
      const denied = await restrictedRpc(26, "tools/call", {
        name: "sessions_send",
        arguments: {
          sessionKey: "agent:main:codex-desktop-lumos-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          message: "blocked-unregistered",
        },
      });
      assert.strictEqual(denied.result.isError, true, restrictedStderr);
      assert.match(denied.result.content[0].text, /not registered/);
      assert.strictEqual(fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length, callsBeforeDenied);

      const wrongAgent = await restrictedRpc(27, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: "agent:main:discord", message: "blocked-agent" },
      });
      assert.strictEqual(wrongAgent.result.isError, true, restrictedStderr);
      assert.match(wrongAgent.result.content[0].text, /not an Eve Desktop dynamic session key/);
      assert.strictEqual(fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length, callsBeforeDenied);

      const aliasBypass = await restrictedRpc(28, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: keyOne, message: "blocked-alias", agentId: "main" },
      });
      assert.strictEqual(aliasBypass.result.isError, true, restrictedStderr);
      assert.match(aliasBypass.result.content[0].text, /does not allow argument: agentId/);
      assert.strictEqual(fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length, callsBeforeDenied);

      const zeroTimeout = await restrictedRpc(30, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: keyOne, message: "blocked-timeout", timeoutSeconds: 0 },
      });
      assert.strictEqual(zeroTimeout.result.isError, true, restrictedStderr);
      assert.match(zeroTimeout.result.content[0].text, /positive integer/);

      const overDeadline = await restrictedRpc(31, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: keyOne, message: "blocked-over-deadline", timeoutSeconds: 3601 },
      });
      assert.strictEqual(overDeadline.result.isError, true, restrictedStderr);
      assert.match(overDeadline.result.content[0].text, /exceeds the proxy deadline/);
      assert.strictEqual(
        fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length,
        callsBeforeDenied
      );

      // `openclaw agent --json` reports only the final assistant message of a
      // run. Subagent completion events are steered into a still-running
      // requester run, so without transcript reconstruction the answer that
      // carried the attachment marker never reaches the caller.
      const transcriptSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const sessionsDir = path.join(root, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:main:discord:direct:other": {
            sessionId: "11111111-2222-4333-8444-555555555555",
          },
          [keyOne]: { sessionId: transcriptSessionId, updatedAt: 1 },
        }),
        "utf8"
      );
      const staleTs = new Date(Date.now() - 600000).toISOString();
      const runTs = (offsetMs) => new Date(Date.now() + 30000 + offsetMs).toISOString();
      const transcriptLines = [
        { type: "session", version: 3, id: transcriptSessionId, timestamp: staleTs },
        {
          type: "message",
          timestamp: staleTs,
          message: { role: "assistant", content: [{ type: "text", text: "stale-earlier-run" }] },
        },
        {
          type: "message",
          timestamp: runTs(0),
          message: { role: "user", idempotencyKey: "fake-run:transcript-one:user", content: [{ type: "text", text: "transcript-one" }] },
        },
        {
          type: "message",
          timestamp: runTs(1000),
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "transcript-answer [[EVE_ATTACHMENT:{\"path\":\"/tmp/x\"}]]" },
              { type: "text", text: "transcript-progress-note" },
              { type: "thinking", thinking: "hidden-thinking" },
            ],
          },
        },
        {
          // Native completion steering does not create a new external user input.
          type: "custom",
          timestamp: runTs(2000),
          customType: "test-internal-event",
          data: { context: "private completion event" },
        },
        {
          type: "message",
          timestamp: runTs(3000),
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "direct:transcript-one" },
            ],
          },
        },
      ];
      fs.writeFileSync(
        path.join(sessionsDir, transcriptSessionId + ".jsonl"),
        transcriptLines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8"
      );

      const rebuilt = await restrictedRpc(32, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: keyOne, message: "transcript-one" },
      });
      assert.strictEqual(rebuilt.result.isError, false, restrictedStderr);
      const rebuiltReply = JSON.parse(rebuilt.result.content[0].text).reply;
      assert.match(rebuiltReply, /transcript-answer/);
      assert.match(rebuiltReply, /\[\[EVE_ATTACHMENT/);
      assert.match(rebuiltReply, /transcript-progress-note/);
      assert.match(rebuiltReply, /direct:transcript-one/);
      assert.ok(!rebuiltReply.includes("hidden-thinking"), rebuiltReply);
      assert.ok(!rebuiltReply.includes("stale-earlier-run"), rebuiltReply);

      // A transcript that does not contain the CLI's own final text cannot be
      // trusted (stale session id, wrong run), so the caller keeps the payload.
      const mismatched = await restrictedRpc(33, "tools/call", {
        name: "sessions_send",
        arguments: { sessionKey: keyOne, message: "transcript-mismatch" },
      });
      assert.strictEqual(mismatched.result.isError, false, restrictedStderr);
      assert.strictEqual(
        JSON.parse(mismatched.result.content[0].text).reply,
        "direct:transcript-mismatch"
      );

      // The upgraded store is authoritative even while old JSON files remain.
      const { DatabaseSync } = require("node:sqlite");
      const databasePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const db = new DatabaseSync(databasePath);
      db.exec(`
        CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT);
        CREATE TABLE session_transcript_index_state(session_id TEXT PRIMARY KEY, needs_rebuild INTEGER);
        CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT);
        CREATE TABLE session_transcript_active_events(session_id TEXT, active_position INTEGER, event_seq INTEGER, message_position INTEGER);
      `);
      db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(keyOne, transcriptSessionId);
      db.prepare("INSERT INTO session_transcript_index_state VALUES (?, 0)").run(transcriptSessionId);
      for (const [i, entry] of transcriptLines.entries()) {
        db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(transcriptSessionId, i, JSON.stringify(entry));
        db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run(transcriptSessionId, i, i, entry.type === "message" ? i : null);
      }
      // An abandoned branch must not leak into a reconstructed reply.
      db.prepare("INSERT INTO transcript_events VALUES (?, 99, ?)").run(transcriptSessionId, JSON.stringify({type:"message", timestamp:runTs(4000), message:{role:"assistant",content:"abandoned-branch"}}));
      const sqliteReplyResult = await restrictedRpc(340, "tools/call", {
        name: "sessions_send", arguments: {sessionKey:keyOne, message:"transcript-one"},
      });
      const sqliteReply = JSON.parse(sqliteReplyResult.result.content[0].text).reply;
      assert.match(sqliteReply, /transcript-answer/);
      assert.match(sqliteReply, /\[\[EVE_ATTACHMENT/);
      assert.ok(!sqliteReply.includes("abandoned-branch"));
      assert.ok(!sqliteReply.includes("hidden-thinking"));
      assert.ok(!sqliteReply.includes("stale-earlier-run"));
      db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
      const dirtyReplyResult = await restrictedRpc(341, "tools/call", {
        name: "sessions_send", arguments: {sessionKey:keyOne, message:"transcript-one"},
      });
      assert.strictEqual(JSON.parse(dirtyReplyResult.result.content[0].text).reply, "direct:transcript-one", "must not fall back to stale JSON when SQLite cannot be trusted");
      db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 0").run();
      const addEntry = (seq, entry) => {
        db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)").run(transcriptSessionId, seq, JSON.stringify(entry));
        db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run(transcriptSessionId, seq, seq, entry.type === "message" ? seq : null);
      };
      // Wait across yield, anchoring the native settle-wake to the accepted
      // child IDs and checking the new run's terminal receipt. One agent send.
      const beforeYieldCalls = fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length;
      const yieldRoot = "fake-run:yield-test";
      const yieldChild = "11111111-1111-4111-8111-111111111111";
      const yieldChildKey = "agent:main:dashboard:yield-child";
      const continuation = `announce:requester-settle:main:${keyOne}:${yieldChild}:yield-1`;
      let messageId = 0;
      const msg = (message) => ({id:"yield-fixture-"+(++messageId),type:"message", message});
      const seedYield = (run, seq) => {
        addEntry(seq, msg({role:"user",idempotencyKey:run+":user"}));
        addEntry(seq+1, msg({role:"assistant",content:[{type:"toolCall",id:"spawn-"+run,name:"sessions_spawn",arguments:{}}]}));
        addEntry(seq+2, msg({role:"toolResult",toolCallId:"spawn-"+run,toolName:"sessions_spawn",content:[{type:"text",text:JSON.stringify({status:"accepted",runId:yieldChild,childSessionKey:yieldChildKey})}]}));
        addEntry(seq+3, msg({role:"assistant",content:[{type:"toolCall",name:"sessions_yield",id:"yield-"+run}]}));
      };
      addEntry(110, msg({role:"user",idempotencyKey:yieldRoot+":user"}));
      addEntry(111, msg({role:"assistant",__openclaw:{runId:yieldRoot},content:[{type:"toolCall",id:"spawn-y",name:"sessions_spawn",arguments:{}}]}));
      addEntry(112, msg({role:"toolResult",__openclaw:{runId:yieldRoot},toolCallId:"spawn-y",toolName:"sessions_spawn",content:[{type:"text",text:JSON.stringify({status:"accepted",runId:yieldChild,childSessionKey:yieldChildKey})}]}));
      addEntry(113, msg({role:"assistant",__openclaw:{runId:yieldRoot},content:[{type:"toolCall",name:"sessions_yield",id:"yield-y"}]}));
      const yieldPromise = restrictedRpc(350, "tools/call", {
        name: "sessions_send", arguments: { sessionKey: keyOne, message: "yield-test", timeoutSeconds: 10 },
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      addEntry(114, msg({role:"user",idempotencyKey:continuation+":user",provenance:{kind:"inter_session",sourceTool:"subagent_announce",sourceSessionKey:yieldChildKey}}));
      addEntry(115, msg({role:"assistant",provider:"openai",stopReason:"stop",__openclaw:{runId:continuation},content:[{type:"text",text:"later-parent-final"}]}));
      const yielded = await yieldPromise;
      assert.strictEqual(yielded.result.isError, false, JSON.stringify(yielded.result.structuredContent));
      assert.strictEqual(yielded.result.structuredContent.reply, "later-parent-final");
      assert.strictEqual(yielded.result.structuredContent.continuationRunId, continuation);
      assert.strictEqual(yielded.result.structuredContent.runId, yieldRoot);
      assert.strictEqual(yielded.result.structuredContent.delivery.status, "returned");
      assert.strictEqual(yielded.result.structuredContent.replySource, "verified_continuation_transcript");
      assert.strictEqual(yielded.result.structuredContent.replyLimitChars, 400000);
      assert.strictEqual(yielded.result.structuredContent.replyTruncated, false);
      assert.ok(!JSON.stringify(yielded).includes("PRIVATE-YIELD-CONTEXT"));
      assert.strictEqual(fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length, beforeYieldCalls + 1);
      // No caller message is resent after a yield wait expires.
      const timeoutRoot = "fake-run:yield-timeout-test";
      seedYield(timeoutRoot, 116);
      const waitingStart = Date.now();
      const yieldedTimeout = await restrictedRpc(364, "tools/call", {
        name:"sessions_send", arguments:{sessionKey:keyOne,message:"yield-timeout-test",timeoutSeconds:1},
      });
      assert.strictEqual(yieldedTimeout.result.structuredContent.code, "DIRECT_AGENT_CONTINUATION_TIMEOUT");
      assert.strictEqual(yieldedTimeout.result.structuredContent.reply, undefined);
      assert.ok(Date.now()-waitingStart >= 31000 && Date.now()-waitingStart < 33000);
      assert.strictEqual(fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length, beforeYieldCalls + 2);
      // An unrelated new user boundary cannot be treated as continuation.
      seedYield("fake-run:yield-superseded", 120);
      addEntry(124, msg({role:"user",idempotencyKey:"another-user:user"}));
      addEntry(125, msg({role:"assistant",content:"do-not-borrow"}));
      const superseded = await restrictedRpc(365, "tools/call", {
        name:"sessions_send", arguments:{sessionKey:keyOne,message:"yield-superseded",timeoutSeconds:1},
      });
      assert.strictEqual(superseded.result.structuredContent.code, "DIRECT_AGENT_NEW_INPUT");
      assert.strictEqual(superseded.result.structuredContent.reply, undefined);
      for (const [i, message] of ["empty-test", "silent-test"].entries()) {
        const empty = await restrictedRpc(351 + i, "tools/call", {
          name: "sessions_send", arguments: { sessionKey: keyOne, message },
        });
        assert.strictEqual(empty.result.isError, true);
        assert.strictEqual(empty.result.structuredContent.status, "empty");
        assert.strictEqual(empty.result.structuredContent.code, "DIRECT_AGENT_EMPTY_FINAL");
        assert.strictEqual(empty.result.structuredContent.reply, undefined);
        assert.strictEqual(empty.result.structuredContent.delivery.externalDelivery, "unverified");
      }
      const interrupted = await restrictedRpc(353, "tools/call", {
        name: "sessions_send", arguments: { sessionKey: keyOne, message: "interrupted-test" },
      });
      assert.strictEqual(interrupted.result.isError, true);
      assert.strictEqual(interrupted.result.structuredContent.code, "DIRECT_AGENT_INTERRUPTED");
      assert.strictEqual(interrupted.result.structuredContent.reply, undefined);
      // Two overlapping caller turns must not borrow an earlier result even
      // when the new transcript tail exists before both CLI callbacks finish.
      addEntry(201, { type: "message", message: { role: "user", idempotencyKey: "fake-run:parallel-a:user", content: "parallel-a" } });
      addEntry(202, { type: "message", message: { role: "assistant", content: "direct:parallel-a" } });
      addEntry(203, { type: "message", message: { role: "user", idempotencyKey: "fake-run:parallel-b:user", content: "parallel-b" } });
      addEntry(204, { type: "message", message: { role: "assistant", content: "direct:parallel-b" } });
      const parallel = await Promise.all(["parallel-a", "parallel-b"].map((message, i) => restrictedRpc(355 + i, "tools/call", {
        name: "sessions_send", arguments: { sessionKey: keyOne, message },
      })));
      parallel.forEach((result, i) => {
        assert.strictEqual(result.result.isError, false);
        assert.strictEqual(result.result.structuredContent.reply, "direct:parallel-" + ["a", "b"][i]);
      });
      db.close();

      // Private directory/registration checks still run before spawning a CLI.
      const registeredPath = path.join(allowlistRoot, dynamicKeyRe.exec(keyOne)[1]);
      fs.chmodSync(registeredPath, 0o644);
      const badMode = await restrictedRpc(360, "tools/call", {
        name: "sessions_send", arguments: { sessionKey: keyOne, message: "bad-mode" },
      });
      assert.strictEqual(badMode.result.isError, true);
      assert.match(badMode.result.content[0].text, /0600/);
      fs.chmodSync(registeredPath, 0o600);
      fs.chmodSync(allowlistRoot, 0o755);
      const badDir = await restrictedRpc(361, "tools/call", {
        name: "sessions_send", arguments: { sessionKey: keyOne, message: "bad-dir" },
      });
      assert.strictEqual(badDir.result.isError, true);
      assert.match(badDir.result.content[0].text, /0700/);
      fs.chmodSync(allowlistRoot, 0o700);
      const registrationBackup = registeredPath + ".backup";
      fs.renameSync(registeredPath, registrationBackup);
      fs.symlinkSync(registrationBackup, registeredPath);
      const linked = await restrictedRpc(363, "tools/call", {
        name: "sessions_send", arguments: { sessionKey: keyOne, message: "bad-symlink" },
      });
      assert.strictEqual(linked.result.isError, true);
      fs.unlinkSync(registeredPath);
      fs.renameSync(registrationBackup, registeredPath);
      assert.ok(!fs.readFileSync(fakeAgentLog, "utf8").includes("bad-mode"));
      assert.ok(!fs.readFileSync(fakeAgentLog, "utf8").includes("bad-dir"));
      assert.ok(!fs.readFileSync(fakeAgentLog, "utf8").includes("bad-symlink"));
      const timeoutCallsBefore = fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length;
      const deadlineStart = Date.now();
      const deadline = await restrictedRpc(362, "tools/call", {
        name: "sessions_send", arguments: { sessionKey: keyOne, message: "deadline-hang", timeoutSeconds: 1 },
      });
      assert.strictEqual(deadline.result.isError, true);
      assert.strictEqual(deadline.result.structuredContent.status, "timeout");
      assert.strictEqual(deadline.result.structuredContent.sentBeforeError, true);
      assert.match(deadline.result.structuredContent.error, /must not be resent/);
      assert.ok(Date.now() - deadlineStart >= 31000);
      assert.ok(Date.now() - deadlineStart < 33000, "SIGTERM-resistant CLI must not exceed original deadline + scheduling tolerance");
      assert.strictEqual(fs.readFileSync(fakeAgentLog, "utf8").trim().split("\n").length, timeoutCallsBefore + 1);

      const startWithArgs = await restrictedRpc(29, "tools/call", {
        name: "sessions_start",
        arguments: { sessionKey: keyOne },
      });
      assert.strictEqual(startWithArgs.result.isError, true, restrictedStderr);
      assert.match(startWithArgs.result.content[0].text, /does not accept arguments/);
    } finally {
      restrictedChild.stdin.end();
      await new Promise((resolve) => restrictedChild.once("exit", resolve));
    }
    const proxyEvents = fs.readFileSync(
      path.join(desktopRoot, "logs", "text-proxy.jsonl"),
      "utf8"
    ).trim().split("\n").map(JSON.parse);
    const processStart = proxyEvents.find((event) => event.event === "process_start");
    assert.strictEqual(processStart.sessionsSendMaxTimeoutSeconds, 3600);
    assert.strictEqual(processStart.sessionsSendHardDeadlineMs, 3630000);
    assert.strictEqual(processStart.sessionsSendCleanupGraceMs, 30000);
    assert.strictEqual(
      processStart.sessionsSendHardDeadlineMs
        - processStart.sessionsSendMaxTimeoutSeconds * 1000,
      processStart.sessionsSendCleanupGraceMs
    );
    assert.ok(processStart.sessionsSendHardDeadlineMs < 3645000);
    process.stdout.write("server integration: requester fallback ok\n");
    process.stdout.write("server integration: gateway wall-clock timeout ok\n");
    assert.ok(!JSON.stringify(proxyEvents).includes("PRIVATE-YIELD-CONTEXT"));
    assert.ok(!proxyEvents.some((event) => event.event === "sessions_send_ok" && event.replyChars === 0));
    assert.ok(proxyEvents.some((event) => event.event === "sessions_send_yielded"));
    assert.ok(proxyEvents.some((event) => event.event === "sessions_send_timeout"));
    process.stdout.write("server integration: dynamic sessions and persistent allowlist ok\n");
    process.stdout.write("server integration: yield continuation final, wait timeout, empty, IDs, no resend, privacy, concurrent reply boundaries, hard deadline ok\n");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fakeGateway.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Spawns a proxy child against a fake loopback gateway that records every
// received invoke body plus its Authorization header.
async function withProxy({ prefix, config, env }, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const calls = [];
  const fakeGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      call.authorization = req.headers.authorization;
      calls.push(call);
      // Mirror tools-invoke-shared: the real cause goes to the gateway log as
      // a "tools-invoke" WARN line and the HTTP body only says it failed.
      if (call.args?.integrationMaskedError) {
        const cause = call.args.integrationMaskedError;
        if (cause !== "silent") {
          fs.appendFileSync(
            path.join(root, "gateway.log"),
            JSON.stringify({
              0: JSON.stringify({ subsystem: "tools-invoke" }),
              1: "tool execution failed: Error: " + cause,
              _meta: { date: new Date().toISOString(), logLevelName: "WARN" },
            }) + "\n"
          );
        }
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { type: "tool_error", message: "tool execution failed" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { active: [], recent: [] } }));
    });
  });
  await new Promise((resolve) => fakeGateway.listen(0, "127.0.0.1", resolve));
  const port = fakeGateway.address().port;
  fs.mkdirSync(path.join(root, "workspace", "temp"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify(config(root, port)),
    "utf8"
  );

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      OPENCLAW_HOME: root,
      OPENCLAW_CLI: path.join(root, "disabled-cli"),
      OPENCLAW_WORKSPACE: path.join(root, "workspace"),
      OPENCLAW_GATEWAY_LOG_FILE: path.join(root, "gateway.log"),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  try {
    await body({ rpc, calls, stderr: () => stderr, root });
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fakeGateway.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// OPENCLAW_MCP_ENABLED_TOOLS must be enforced on tools/call, not only by
// filtering tools/list: a client can call a name it was never advertised.
async function serverSideToolAllowlist() {
  await withProxy({
    prefix: "openclaw-mcp-proxy-allowlist-",
    config: (root, port) => ({
      gateway: { port, auth: { mode: "token", token: "test-token" } },
    }),
    env: {
      OPENCLAW_REQUESTER_SESSION_KEY: "agent:main:integration:allowlist",
      OPENCLAW_MCP_ENABLED_TOOLS: "subagents",
    },
  }, async ({ rpc, calls, stderr }) => {
    const toolList = await rpc(1, "tools/list", {});
    assert.deepStrictEqual(
      toolList.result.tools.map((tool) => tool.name),
      ["subagents"],
      stderr()
    );

    const allowed = await rpc(2, "tools/call", {
      name: "subagents",
      arguments: { action: "list" },
    });
    assert.strictEqual(allowed.result.isError, false, stderr());
    assert.strictEqual(calls.length, 1);

    // "read" is a proxy-local tool, so a client calling it unadvertised would
    // otherwise reach the filesystem without ever touching the gateway.
    const blocked = await rpc(3, "tools/call", {
      name: "read",
      arguments: { path: "/etc/hosts" },
    });
    assert.strictEqual(blocked.result, undefined, "disallowed tool must not return a result");
    assert.strictEqual(blocked.error.code, -32601);
    assert.strictEqual(calls.length, 1, "blocked call must not reach the gateway");
    process.stdout.write("server integration: server-side tool allowlist ok\n");
  });
}

// gateway.auth.token may be a secret reference rather than a literal; a plain
// concatenation would send "Bearer [object Object]" and 401 on every call.
async function secretRefAuthAndAliasStripping() {
  await withProxy({
    prefix: "openclaw-mcp-proxy-secretref-",
    config: (root, port) => {
      const secretsPath = path.join(root, "secrets.json");
      fs.writeFileSync(
        secretsPath,
        JSON.stringify({ config: { gatewayAuthToken: "resolved-secret-token" } }),
        "utf8"
      );
      return {
        gateway: {
          port,
          auth: {
            mode: "token",
            token: { source: "file", provider: "vault", id: "/config/gatewayAuthToken" },
          },
        },
        secrets: { providers: { vault: { path: secretsPath, mode: "json" } } },
        agents: {
          ownership: "explicit",
          entries: { main: {}, marco: {} },
          defaults: { systemAgent: { agentId: "main" } },
        },
      };
    },
    env: { OPENCLAW_REQUESTER_SESSION_KEY: "agent:main:integration:secretref" },
  }, async ({ rpc, calls, stderr }) => {
    const listed = await rpc(1, "tools/call", {
      name: "subagents",
      arguments: { action: "list" },
    });
    assert.strictEqual(listed.result.isError, false, stderr());
    assert.strictEqual(calls.at(-1).authorization, "Bearer resolved-secret-token");

    // Both the alias and the canonical key: the gateway rejects `limit`, so the
    // proxy must forward only `count`.
    await rpc(2, "tools/call", {
      name: "web_search",
      arguments: { query: "alias", limit: 3, count: 7 },
    });
    assert.strictEqual(calls.at(-1).args.limit, undefined, "proxy-only alias must be stripped");
    assert.strictEqual(calls.at(-1).args.count, 7, "explicit canonical value wins");
    process.stdout.write("server integration: secret-ref auth and alias stripping ok\n");
  });
}

// The gateway masks non-input tool errors as "tool execution failed" and only
// logs the cause. The proxy must read that line back so the client can tell
// a run-instance gate from a crash, and must say so when nothing was logged.
async function maskedGatewayErrorReadBack() {
  await withProxy({
    prefix: "openclaw-mcp-proxy-masked-error-",
    config: (root, port) => ({
      gateway: { port, auth: { mode: "token", token: "test-token" } },
    }),
    env: {
      OPENCLAW_REQUESTER_SESSION_KEY: "agent:main:integration:masked-error",
    },
  }, async ({ rpc, stderr, root }) => {
    // Stale line from an earlier call must not be attributed to this request.
    fs.writeFileSync(
      path.join(root, "gateway.log"),
      JSON.stringify({
        0: JSON.stringify({ subsystem: "tools-invoke" }),
        1: "tool execution failed: Error: stale cause from a previous call",
        _meta: { date: new Date(Date.now() - 60000).toISOString(), logLevelName: "WARN" },
      }) + "\n"
    );
    const explained = await rpc(1, "tools/call", {
      name: "automations",
      arguments: {
        action: "get",
        jobId: "job-1",
        integrationMaskedError: "trusted operational run instance required for this gateway call",
      },
    });
    assert.strictEqual(explained.result.isError, true, stderr());
    assert.strictEqual(
      explained.result.content[0].text,
      "Error: tool execution failed (gateway: trusted operational run instance required for this gateway call)",
      stderr()
    );

    const silent = await rpc(2, "tools/call", {
      name: "automations",
      arguments: { action: "get", jobId: "job-1", integrationMaskedError: "silent" },
    });
    assert.strictEqual(silent.result.isError, true, stderr());
    assert.ok(
      silent.result.content[0].text.startsWith("Error: tool execution failed (HTTP 500 from gateway for automations; no matching tools-invoke line"),
      silent.result.content[0].text
    );
    // Stale line is older than the request, so it must not be picked up either.
    assert.ok(!silent.result.content[0].text.includes("stale cause"), silent.result.content[0].text);
    process.stdout.write("server integration: masked gateway error read-back ok\n");
  });
}

main()
  .then(serverSideToolAllowlist)
  .then(secretRefAuthAndAliasStripping)
  .then(maskedGatewayErrorReadBack)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
