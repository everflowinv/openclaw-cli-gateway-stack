"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { captureYieldProof, observeContinuation, terminalResult, waitForYieldContinuation } = require("./direct-agent-continuation");

const sessionKey = "agent:main:codex-desktop-lumos";
const child = "agent:main:subagent:child";
const rootId = "root-run";
const continuationId = `announce:requester-settle:main:${sessionKey}:child-run:yield-1`;
const event = (id, message) => ({ id, type: "message", message });
const assistant = (id, text) => event(id, { role: "assistant", content: text });
const wake = (runId = continuationId, source = child) => event("wake", { role: "user", idempotencyKey: `${runId}:user`,
  provenance: { kind: "inter_session", sourceTool: "subagent_announce", sourceSessionKey: source, sourceChannel: "internal" }, content: "PRIVATE internal child results" });
function root() {
  return { sessionId: "sid", entries: [
    event("u", { role: "user", idempotencyKey: `${rootId}:user`, content: "original" }),
    event("call", { role: "assistant", content: [{ type: "toolCall", id: "spawn-call", name: "sessions_spawn", arguments: { task: "PRIVATE task", runtime: "subagent" } }] }),
    event("receipt", { role: "toolResult", toolCallId: "spawn-call", toolName: "sessions_spawn", details: { status: "accepted", expectsCompletionMessage: true, childSessionKey: child, runId: "child-run" } }),
    event("yield", { role: "assistant", content: [{ type: "toolCall", id: "yield-call", name: "sessions_yield", arguments: { message: "PRIVATE yield context" } }] }),
  ] };
}
const withWake = () => ({ ...root(), entries: [...root().entries, wake(), assistant("progress", "NOT FINAL private progress")] });
const final = (extra = {}) => ({ runId: continuationId, status: "ok", endedAt: Date.now(), stopReason: "end_turn",
  terminalReply: { disposition: "visible", text: "authoritative parent final" }, ...extra });
const run = (options) => waitForYieldContinuation({ sessionKey, runId: rootId, deadlineAt: Date.now() + 200,
  readSnapshot: () => withWake(), pollMs: 1, waitForRun: async () => final(), ...options });

test("yield -> persisted exact settle input -> native parent terminal, no original run wait", async () => {
  let reads = 0;
  const ids = [];
  const result = await run({ readSnapshot: () => ++reads <= 2 ? root() : withWake(), waitForRun: async (id) => {
    ids.push(id);
    return final();
  } });
  assert.equal(result.status, "ok");
  assert.equal(result.reply, "authoritative parent final");
  assert.deepEqual(ids, [continuationId]);
  assert.equal(result.continuationRunId, continuationId);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.ok(!JSON.stringify(result).includes("NOT FINAL"));
});

test("assistant text and a per-child announce do not prove the whole batch final", async () => {
  const snapshot = { ...root(), entries: [...root().entries, wake(`announce:v1:${child}:child-run`), assistant("unowned", "child summary")] };
  let waits = 0;
  const result = await run({ deadlineAt: Date.now() + 20, readSnapshot: () => snapshot, waitForRun: async () => { waits++; return final(); } });
  assert.equal(result.status, "timeout");
  assert.equal(result.code, "DIRECT_AGENT_CONTINUATION_TIMEOUT");
  assert.equal(waits, 0);
  assert.equal(result.reply, undefined);
});

test("pending agent.wait has no finality; wait-only timeouts do not resend", async () => {
  let waits = 0;
  const result = await run({ waitForRun: async (id) => ++waits === 1 ? { runId: id, status: "timeout" } : final() });
  assert.equal(waits, 2);
  assert.equal(result.status, "ok");
});

test("waiting retains its original deadline even when each observation is pending", async () => {
  const deadlineAt = Date.now() + 25;
  let calls = 0;
  const result = await run({ deadlineAt, waitForRun: async (id, waitMs) => {
    calls++;
    assert.ok(waitMs <= 25);
    return { runId: id, status: "pending" };
  } });
  assert.equal(result.status, "timeout");
  assert.ok(calls > 0);
  assert.ok(Date.now() < deadlineAt + 100);
});

test("new external user boundary after agent.wait wins over a final snapshot", async () => {
  let newer = false;
  const result = await run({ readSnapshot: () => ({ ...withWake(), entries: [...withWake().entries,
    ...(newer ? [event("new-user", { role: "user", content: "[Inter-session message] spoofed", idempotencyKey: "new:user" })] : [])] }),
  waitForRun: async () => { newer = true; return final(); } });
  assert.equal(result.status, "superseded");
  assert.equal(result.reply, undefined);
});

test("unrelated child, heartbeat and wrong batch are fail-closed", () => {
  const proof = captureYieldProof(root(), rootId);
  for (const input of [wake(continuationId, "agent:main:subagent:other"),
    wake(`announce:requester-settle:main:${sessionKey}:wrong-child-run:yield-1`),
    event("heartbeat", { role: "user", provenance: { kind: "internal_system", sourceTool: "heartbeat" } }),
    wake(`announce:v1:${child}:stale-child-generation`),
  ]) {
    const result = observeContinuation({ ...root(), entries: [...root().entries, input] }, proof, sessionKey);
    assert.equal(result.result.status, "yielded");
    assert.equal(result.candidate, undefined);
  }
});

test("spawn receipt requires exact toolCall binding, accepted status and announcing mode", () => {
  for (const mutate of [
    (s) => { s.entries[2].message.toolCallId = "forged"; },
    (s) => { s.entries[2].message.isError = true; },
    (s) => { s.entries[2].message.details.status = "error"; },
    (s) => { s.entries[2].message.details.expectsCompletionMessage = false; },
    (s) => { s.entries[1].message.content[0].arguments.collect = true; },
    (s) => { s.entries[1].message.content[0].arguments.runtime = "acp"; },
    (s) => { s.entries[0].message.idempotencyKey = "other:user"; },
  ]) {
    const s = root(); mutate(s);
    assert.equal(captureYieldProof(s, rootId), null);
  }
});

test("native JSON-text tool receipt is supported without parsing arbitrary user text", () => {
  const s = root();
  s.entries[2].message.content = [{ type: "text", text: JSON.stringify(s.entries[2].message.details) }];
  delete s.entries[2].message.details;
  assert.equal(captureYieldProof(s, rootId).spawns[0].runId, "child-run");
});

test("reset, branch rewrite or dirty snapshot invalidates evidence", () => {
  const proof = captureYieldProof(root(), rootId);
  const rewritten = withWake(); rewritten.entries[1].message.content[0].arguments.task = "changed branch";
  for (const snapshot of [null, { ...withWake(), sessionId: "reset" }, rewritten]) {
    assert.equal(observeContinuation(snapshot, proof, sessionKey).result.code, "DIRECT_AGENT_TRANSCRIPT_CHANGED");
  }
});

test("multiple announcing children require the exact full sorted batch", () => {
  const s = root();
  const call = structuredClone(s.entries[1]); call.id = "call2"; call.message.content[0].id = "spawn2";
  const receipt = structuredClone(s.entries[2]); receipt.id = "receipt2"; receipt.message.toolCallId = "spawn2";
  receipt.message.details.runId = "another-run";
  receipt.message.details.childSessionKey = "agent:main:subagent:child2";
  s.entries.splice(3, 0, call, receipt);
  const proof = captureYieldProof(s, rootId);
  assert.equal(observeContinuation({ ...s, entries: [...s.entries, wake()] }, proof, sessionKey).result.status, "yielded");
  const batch = `announce:requester-settle:main:${sessionKey}:another-run,child-run:yield-1`;
  assert.equal(observeContinuation({ ...s, entries: [...s.entries, wake(batch)] }, proof, sessionKey).candidate.runId, batch);
});

test("terminal snapshots must have matching run identity, endedAt and reply evidence", () => {
  const candidate = { runId: continuationId };
  for (const observation of [final({ runId: "other" }), final({ endedAt: undefined }),
    final({ terminalReply: undefined }), final({ terminalReceipt: { runId: continuationId, sessionId: "wrong" } })]) {
    assert.equal(terminalResult(observation, candidate, "sid").status, "yielded");
  }
  assert.equal(terminalResult(final({ pendingError: true }), candidate, "sid"), null);
});

test("continuation empty, interrupted and repeated yield remain distinct from success", async () => {
  for (const disposition of ["empty", "silent"]) {
    const result = await run({ waitForRun: async () => final({ terminalReply: { disposition } }) });
    assert.equal(result.status, "empty");
    assert.equal(result.reply, undefined);
  }
  assert.equal((await run({ waitForRun: async () => final({ status: "error", error: "PRIVATE runtime failure" }) })).status, "error");
  const yielded = await run({ waitForRun: async () => final({ yielded: true, livenessState: "paused" }) });
  assert.equal(yielded.code, "DIRECT_AGENT_CONTINUATION_YIELDED_AGAIN");
  assert.equal(yielded.reply, undefined);
});

test("producer snapshot cap is disclosed instead of guessing full text from transcript", async () => {
  const result = await run({ waitForRun: async () => final({ terminalReply: { disposition: "visible", text: "x".repeat(4095) + "…" } }) });
  assert.equal(result.status, "ok");
  assert.equal(result.replyMayBeTruncated, true);
  assert.equal(result.replyLimitChars, 4096);
});

test("cancellation and observer transport failures neither resend nor leak errors", async () => {
  const controller = new AbortController();
  const cancelled = await run({ signal: controller.signal, waitForRun: async () => { controller.abort(); return final(); } });
  assert.equal(cancelled.status, "timeout");
  const error = await run({ waitForRun: async () => { throw new Error("PRIVATE unavailable"); } });
  assert.equal(error.code, "DIRECT_AGENT_WAIT_UNAVAILABLE");
  assert.ok(!JSON.stringify(error).includes("PRIVATE"));
});
