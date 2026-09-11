"use strict";

const { createHash } = require("node:crypto");
const { readSqliteActiveSnapshot } = require("./session-reply-store");
const { expandContinuationReply, DEFAULT_FULL_REPLY_MAX_CHARS } = require("./continuation-full-reply");

// Narrow native contract (OpenClaw 2026.9.1): a yielded request's accepted
// announcing spawns form an exact batch. requester-settle wake persists a new
// `${announceRunId}:user` with subagent_announce provenance and that batch in
// its idempotency key. Ordinary per-child announcements are NOT final receipts.
// Never guess a runId to wait on; use only a matching persisted input's key.
const CHILD_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SILENT = new Set(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP", "REPLY_SKIP"]);

function blocked(code = "DIRECT_AGENT_CONTINUATION_UNOBSERVABLE") {
  return { status: "yielded", execution: "yielded", code, retryable: false,
    error: "The run yielded, not completed; a reliable continuation final is unavailable. Do not resend the original message automatically." };
}
function timedOut() {
  return { status: "timeout", execution: "yielded", code: "DIRECT_AGENT_CONTINUATION_TIMEOUT", retryable: false,
    error: "Waiting for the related parent final timed out within the original call budget; work may continue. Do not resend automatically." };
}
function externalBoundary() {
  return { status: "superseded", execution: "unknown", code: "DIRECT_AGENT_NEW_INPUT", retryable: false,
    error: "A new user input crossed this request's reply boundary. No later reply was attributed to this request. Do not resend automatically." };
}
const hash = (entries) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");
const callsIn = (entry) => entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)
  ? entry.message.content.filter((b) => b?.type === "toolCall") : [];

function receiptOf(message) {
  if (message.details && typeof message.details === "object" && !Array.isArray(message.details)) return message.details;
  try {
    const content = typeof message.content === "string" ? message.content : message.content
      .filter((b) => b?.type === "text").map((b) => b.text).join("\n");
    return JSON.parse(content);
  } catch (_) { return null; }
}

function captureYieldProof(snapshot, runId) {
  if (!snapshot || !runId) return null;
  const { entries } = snapshot;
  const roots = entries.flatMap((e, i) => e.type === "message" && e.message?.role === "user"
    && e.message.idempotencyKey === `${runId}:user` ? [i] : []);
  if (roots.length !== 1 || typeof entries[roots[0]].id !== "string") return null;
  const root = roots[0];
  const calls = new Map();
  const spawns = [];
  let yieldIndex = -1;
  for (let i = root + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "user") break;
    for (const call of callsIn(entry)) {
      if (call.name === "sessions_yield") { yieldIndex = i; break; }
      if (call.name === "sessions_spawn" && typeof call.id === "string") {
        if (calls.has(call.id)) return null;
        calls.set(call.id, call);
      }
    }
    if (yieldIndex !== -1) break;
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "toolResult" || message.isError === true) continue;
    const call = calls.get(message.toolCallId);
    if (!call || message.toolName && message.toolName !== "sessions_spawn") continue;
    calls.delete(message.toolCallId);
    const receipt = receiptOf(message);
    if (receipt?.status !== "accepted" || receipt.expectsCompletionMessage === false
        || call.arguments?.expectsCompletionMessage === false || call.arguments?.collect === true
        || call.arguments?.runtime === "acp") continue;
    if (typeof receipt.childSessionKey !== "string" || !/^agent:[^:]+:.+/.test(receipt.childSessionKey)
        || receipt.childSessionKey.length > 512 || !CHILD_RUN_ID.test(receipt.runId ?? "")) return null;
    spawns.push({ childSessionKey: receipt.childSessionKey, runId: receipt.runId });
  }
  if (yieldIndex < 0 || typeof entries[yieldIndex].id !== "string" || !spawns.length || new Set(spawns.map((s) => s.runId)).size !== spawns.length) return null;
  return { sessionId: snapshot.sessionId, rootId: entries[root].id, runId,
    yieldId: entries[yieldIndex].id, prefixHash: hash(entries.slice(root, yieldIndex + 1)),
    spawns, root, yieldIndex };
}

function observeContinuation(snapshot, proof, sessionKey) {
  if (!snapshot || snapshot.sessionId !== proof.sessionId) return { result: blocked("DIRECT_AGENT_TRANSCRIPT_CHANGED") };
  const current = captureYieldProof(snapshot, proof.runId);
  if (!current || current.rootId !== proof.rootId || current.yieldId !== proof.yieldId || current.prefixHash !== proof.prefixHash) {
    return { result: blocked("DIRECT_AGENT_TRANSCRIPT_CHANGED") };
  }
  const childKeys = new Set(proof.spawns.map((s) => s.childSessionKey));
  const batchIds = proof.spawns.map((s) => s.runId).sort().join(",");
  const settlePrefix = `announce:requester-settle:main:${sessionKey}:${batchIds}:yield-`;
  let candidate;
  for (const entry of snapshot.entries.slice(current.yieldIndex + 1)) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const message = entry.message;
    const provenance = message.provenance;
    // Text that looks like an internal envelope is still an external input.
    if (!provenance || provenance.kind === "external_user") return { result: externalBoundary() };
    if (provenance.kind !== "inter_session" || provenance.sourceTool !== "subagent_announce"
        || !childKeys.has(provenance.sourceSessionKey)) return { result: blocked("DIRECT_AGENT_UNRELATED_INPUT") };
    const key = message.idempotencyKey;
    if (typeof key !== "string" || !key.endsWith(":user") || typeof entry.id !== "string") {
      return { result: blocked("DIRECT_AGENT_CONTINUATION_ID_MISSING") };
    }
    const runId = key.slice(0, -5);
    if (runId.startsWith(settlePrefix) && /^[1-9]\d*(?::retry-[1-9]\d*)?$/.test(runId.slice(settlePrefix.length))) {
      candidate ??= { runId, inputId: entry.id };
      continue;
    }
    // A per-child input is allowed context, never accepted as whole-task final.
    const isChildAnnounce = proof.spawns.some((s) => s.childSessionKey === provenance.sourceSessionKey && runId === `announce:v1:${s.childSessionKey}:${s.runId}`);
    if (!isChildAnnounce) return { result: blocked("DIRECT_AGENT_UNRELATED_INPUT") };
  }
  return { candidate };
}

function terminalResult(wait, candidate, sessionId) {
  if (!wait || wait.runId !== candidate.runId) return blocked("DIRECT_AGENT_WAIT_ID_MISMATCH");
  if (wait.pendingError === true || wait.status === "pending"
      || wait.status === "timeout" && !Number.isFinite(wait.endedAt)) return null;
  if (wait.yielded === true || wait.livenessState === "paused") return blocked("DIRECT_AGENT_CONTINUATION_YIELDED_AGAIN");
  if (!Number.isFinite(wait.endedAt)) return blocked("DIRECT_AGENT_FINAL_RECEIPT_MISSING");
  if (wait.status !== "ok" || wait.error || ["error", "aborted"].includes(wait.stopReason)) {
    return { status: wait.status === "timeout" ? "timeout" : "error", execution: "interrupted",
      code: "DIRECT_AGENT_CONTINUATION_FAILED", retryable: false,
      error: "The related parent continuation did not complete successfully. Do not resend automatically." };
  }
  const receipt = wait.terminalReceipt;
  if (receipt && (receipt.runId !== candidate.runId || receipt.sessionId !== sessionId)) return blocked("DIRECT_AGENT_FINAL_RECEIPT_MISMATCH");
  const final = wait.terminalReply;
  if (["empty", "silent"].includes(final?.disposition)) return { status: "empty", execution: "completed",
    code: "DIRECT_AGENT_EMPTY_FINAL", retryable: false,
    error: "The related parent run ended without a visible text reply; external delivery is unverified. Do not resend automatically." };
  if (final?.disposition !== "visible" || typeof final.text !== "string" || !final.text.trim() || final.text.length > 4096 || SILENT.has(final.text.trim())) {
    return blocked("DIRECT_AGENT_FINAL_RECEIPT_MISSING");
  }
  // Use producer-sanitized terminal text, NOT transcript latest/prefix matching.
  // Native snapshots are capped at 4096 UTF-16 chars; state that limitation.
  return { status: "ok", execution: "completed", reply: final.text,
    replySource: "native_terminal_snapshot", replyBlocks: 1,
    replyMayBeTruncated: final.text.length >= 4095, replyLimitChars: 4096 };
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

async function waitForYieldContinuation({ databasePath, sessionKey, runId, deadlineAt, signal, waitForRun,
  readSnapshot = () => readSqliteActiveSnapshot(databasePath, sessionKey), pollMs = 1000,
  maxReplyChars = DEFAULT_FULL_REPLY_MAX_CHARS }) {
  const proof = captureYieldProof(readSnapshot(), runId);
  if (!proof) return blocked();
  while (!signal?.aborted && Date.now() < deadlineAt) {
    const observed = observeContinuation(readSnapshot(), proof, sessionKey);
    if (observed.result) return observed.result;
    if (observed.candidate) {
      const candidate = observed.candidate;
      let wait;
      try {
        wait = await waitForRun(candidate.runId, Math.min(10000, Math.max(1, deadlineAt - Date.now())), signal);
      } catch (_) {
        return signal?.aborted || Date.now() >= deadlineAt ? timedOut() : blocked("DIRECT_AGENT_WAIT_UNAVAILABLE");
      }
      if (signal?.aborted || Date.now() >= deadlineAt) return timedOut();
      // Recheck after every asynchronous observation. New user input/reset wins
      // even if agent.wait just returned a successful terminal snapshot.
      const freshSnapshot = readSnapshot();
      const fresh = observeContinuation(freshSnapshot, proof, sessionKey);
      if (fresh.result) return fresh.result;
      if (fresh.candidate?.runId !== candidate.runId || fresh.candidate.inputId !== candidate.inputId) return blocked("DIRECT_AGENT_TRANSCRIPT_CHANGED");
      const terminal = terminalResult(wait, candidate, proof.sessionId);
      if (terminal) {
        const expanded = expandContinuationReply(freshSnapshot, candidate, wait, terminal, maxReplyChars);
        if (signal?.aborted || Date.now() >= deadlineAt) return timedOut();
        return { ...expanded, continuationRunId: candidate.runId };
      }
    }
    await pause(Math.min(pollMs, Math.max(0, deadlineAt - Date.now())), signal);
  }
  return timedOut();
}

module.exports = { captureYieldProof, observeContinuation, terminalResult, waitForYieldContinuation };
