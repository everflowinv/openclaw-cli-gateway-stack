#!/usr/bin/env node
import { estimateUsageCost } from "../lib/usage-cost.mjs";
// Antigravity CLI Gateway — OpenAI-compatible façade over `agy` print mode.
// Modeled on claude-cli-gateway/server.mjs; see README.md for differences
// (text-only input, step-granularity streaming, per-model effort suffixes).

import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizedAgyUsage as normalizedUsage, rawAgyUsage as rawUsage, contextAgyUsage, truncateText } from "../lib/cli-output.mjs";

import { createCliVersionProbe } from "../lib/cli-version.mjs";
import { createCliProcessCleanup } from "../lib/cli-process-cleanup.mjs";
import { applyAllowedToolsEnv, parseResponseFormat, readOpenClawToolNames, resolveAllowedTools } from "../lib/openai-request.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// OpenClaw workspace location; agy itself runs in the isolated AGY_CWD.
const WORKSPACE = process.env.AGY_CLI_GATEWAY_WORKSPACE
  || process.env.OPENCLAW_WORKSPACE
  || path.join(os.homedir(), ".openclaw", "workspace");
// agy keeps its own built-in file/shell/browser tools alive even when the
// request only needs OpenClaw MCP tools, so it runs in a dedicated empty cwd
// instead of the shared workspace.
const AGY_CWD = process.env.AGY_CLI_GATEWAY_CWD || path.join(HERE, "cwd");
const HOST = process.env.AGY_CLI_GATEWAY_HOST || "127.0.0.1";
const PORT = numberFromEnv("AGY_CLI_GATEWAY_PORT", 4569, 1, 65535);
const AGY_BIN = process.env.AGY_CLI_BIN || path.join(os.homedir(), ".local", "bin", "agy");
const MAX_CONCURRENT = numberFromEnv("AGY_CLI_GATEWAY_MAX_CONCURRENT", 4, 1, 32);
const QUEUE_TIMEOUT_MS = numberFromEnv("AGY_CLI_GATEWAY_QUEUE_TIMEOUT_SECONDS", 120, 1, 3600) * 1000;
const TIMEOUT_MS = numberFromEnv("AGY_CLI_GATEWAY_TIMEOUT_SECONDS", 3600, 30, 86400) * 1000;
// Hard per-call ceiling for openclaw exec/process tools (see claude gateway
// rationale: caller turn timeouts must always outlive the tools they wait on).
const EXEC_MAX_TIMEOUT_MS = numberFromEnv(
  "AGY_CLI_GATEWAY_EXEC_MAX_TIMEOUT_MS",
  600000,
  1000,
  1800000,
);
const MAX_BODY_BYTES = numberFromEnv("AGY_CLI_GATEWAY_MAX_BODY_MB", 64, 1, 256) * 1024 * 1024;
const API_KEY = process.env.AGY_CLI_GATEWAY_API_KEY || "";
// agy still truncates the model-facing user message near 192000 UTF-8
// bytes (re-verified on 1.3.3, 2026-10-12: 185KB kept all six random
// markers, 260KB kept only the first four), then returns SUCCESS/exit 0
// without a stream-json or stderr warning.
// Its stored generation request contains the internal truncation notice.
// Multiple text blocks do not avoid it. Keep headroom for CLI-added framing;
// counting JS characters would allow Chinese/emoji prompts to exceed the cap.
// MAX_PROMPT_CHARS is a deprecated fallback alias, now interpreted as bytes.
const MAX_PROMPT_BYTES = numberFromEnv(
  "AGY_CLI_GATEWAY_MAX_PROMPT_BYTES",
  numberFromEnv("AGY_CLI_GATEWAY_MAX_PROMPT_CHARS", 190000, 10000, 10000000),
  10000,
  10000000,
);
// agy 1.1.26 can silently lose the model stream mid-response (proxy kills
// the long-lived connection; agy never notices and keeps running background
// polls forever). If agy produces no stdout at all for this long, kill it and
// surface an error so OpenClaw can fail over instead of waiting TIMEOUT_MS.
// Generously sized: a pure long-thinking phase also produces no output.
const STALL_TIMEOUT_MS = numberFromEnv("AGY_CLI_GATEWAY_STALL_SECONDS", 600, 1, 3600) * 1000;
// agy streams one text_delta per completed agent step, not per token, and
// emits nothing at all while tools run. Same watchdog workaround as the
// claude gateway: reasoning_content heartbeats on tool activity and after
// idle silence. 0 disables the idle timer.
const HEARTBEAT_IDLE_MS = numberFromEnv("AGY_CLI_GATEWAY_HEARTBEAT_SECONDS", 120, 0, 3600) * 1000;
const LIVE_LOG_PREFIX = "[AGYGW]";

// One catalog entry per base model, mirroring `agy models` on agy 1.3.3
// (verified 2026-10-12: suffixed ids only; gemini-3.1-pro is no longer
// recognized at all and was removed). Reasoning effort arrives per-request
// as OpenAI `reasoning_effort` (OpenClaw thinking level); agy's canonical
// selection is now the suffixed model id ("gemini-3.8-flash-low"), so the
// gateway sends `--model <base>-<effort>` and no `--effort` flag — the old
// base-plus-flag form is intermittently rejected upstream ("--effort is
// not supported for model"). Inbound suffixed ids like
// "gemini-3.8-flash-high" are still accepted and pin the effort unless the
// request overrides it. `agy --help` advertises xhigh/max, but the live
// catalog only offers the efforts listed per model below.
const MODELS = new Map([
  ["gemini-3.8-flash", { id: "gemini-3.8-flash", agyModel: "gemini-3.8-flash", agyEfforts: ["low", "medium", "high"], created: 1784851200, input: ["text"], reasoning: true }],
  ["claude-opus-5-5", { id: "claude-opus-5-5", agyModel: "claude-opus-5-5", agyEfforts: ["low", "medium", "high"], created: 1784851200, input: ["text"], reasoning: true }],
  ["claude-sonnet-5-5", { id: "claude-sonnet-5-5", agyModel: "claude-sonnet-5-5", agyEfforts: ["low", "medium", "high"], created: 1784851200, input: ["text"], reasoning: true }],
  ["gpt-oss-120b", { id: "gpt-oss-120b", agyModel: "gpt-oss-120b", agyEfforts: ["medium"], created: 1784851200, input: ["text"], reasoning: true }],
]);
const EFFORTS = ["low", "medium", "high"];
const DEFAULT_EFFORT = process.env.AGY_CLI_GATEWAY_DEFAULT_EFFORT || "low";
const KNOWN_TOOLS = readOpenClawToolNames(path.join(HERE, "..", "openclaw-mcp-proxy", "tools-schema.json"));

function resolveModelId(requested) {
  if (typeof requested !== 'string') return null;
  if (MODELS.has(requested)) return { base: requested, suffixEffort: null };
  for (const effort of EFFORTS) {
    if (requested.endsWith(`-${effort}`)) {
      const base = requested.slice(0, -(effort.length + 1));
      if (MODELS.has(base)) return { base, suffixEffort: effort };
    }
  }
  return null;
}

// OpenClaw levels clamp into the model's catalogued efforts: upward
// (xhigh/max/ultra -> the model's highest) or downward (none/minimal/off
// -> the model's lowest); an exact level the model lacks lands on the
// nearest available one. Missing values fall back to the pinned suffix or
// DEFAULT_EFFORT; unknowns fail.
function mapEffort(requested, fallbackEffort, modelMeta) {
  const value = requested == null || requested === "" ? (fallbackEffort || DEFAULT_EFFORT) : String(requested).toLowerCase();
  if (![...EFFORTS, "none", "minimal", "off", "xhigh", "max", "ultra"].includes(value)) throw requestError(`Unsupported reasoning_effort '${requested}'`);
  const available = modelMeta?.agyEfforts?.length ? modelMeta.agyEfforts : EFFORTS;
  if (value === "none" || value === "minimal" || value === "off") return available[0];
  if (value === "xhigh" || value === "max" || value === "ultra") return available.at(-1);
  if (available.includes(value)) return value;
  const rank = EFFORTS.indexOf(value);
  return available.reduce((best, effort) =>
    Math.abs(EFFORTS.indexOf(effort) - rank) < Math.abs(EFFORTS.indexOf(best) - rank) ? effort : best);
}

let activeRequests = 0;
const waiters = [];
const shutdownController = new AbortController();
const runningCancels = new Set();

function writeLiveLog(requestId, event, fields = {}) {
  const record = {
    v: 1,
    ts: new Date().toISOString(),
    request: requestId,
    event,
    ...fields,
  };
  process.stdout.write(`${LIVE_LOG_PREFIX} ${JSON.stringify(record)}\n`);
}

function numberFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return Math.trunc(value);
}

function acquireSlot(signal) {
  const cancelled = () => Object.assign(new Error('Queued request cancelled'), { code: 'CLI_CANCELLED', statusCode: 499 });
  if (signal?.aborted) return Promise.reject(cancelled());
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests += 1;
    return Promise.resolve(releaseSlot);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        activeRequests += 1;
        resolve(releaseSlot);
      },
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      signal?.removeEventListener('abort', abort);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      const error = new Error(`Antigravity CLI gateway queue timed out after ${Math.round(QUEUE_TIMEOUT_MS / 1000)} seconds`);
      error.code = "AGY_CLI_QUEUE_TIMEOUT";
      error.statusCode = 503;
      reject(error);
    }, QUEUE_TIMEOUT_MS);
    timer.unref();
    waiters.push(waiter);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waiters.shift();
  if (next) next.grant();
}

function sendJson(res, status, body) {
  if (res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function openAIError(message, type = "invalid_request_error", code = null) {
  return { error: { message, type, param: null, code } };
}

function requireAuth(req) {
  if (!API_KEY) return true;
  return req.headers.authorization === `Bearer ${API_KEY}`;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      req.resume();
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function pushText(blocks, value) {
  const text = String(value || "");
  if (!text) return;
  const previous = blocks.at(-1);
  if (previous?.type === "text") previous.text += text;
  else blocks.push({ type: "text", text });
}

// agy stream-json input accepts text content blocks only; anything else
// (images, audio, files) must be rejected so OpenClaw can fail over to a
// multimodal provider instead of getting a truncated request.
function contentText(content, messageIndex) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts = [];
  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const block = content[blockIndex];
    const label = `messages[${messageIndex}].content[${blockIndex}]`;
    if (typeof block === "string") {
      parts.push(block);
    } else if ((block?.type === "text" || block?.type === "input_text") && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "image_url" || block?.type === "input_image" || block?.type === "image") {
      throw requestError(`${label} is an image, but the Antigravity CLI only accepts text in headless mode; route image requests to a multimodal provider`);
    } else if (block?.type === "file" || block?.type === "input_file" || block?.type === "audio") {
      throw requestError(`${label} is a non-text attachment, which the Antigravity CLI headless mode does not accept`);
    } else if (block !== null && block !== undefined) {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

function messageText(message, messageIndex) {
  let text = contentText(message?.content, messageIndex);
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    if (text) text += "\n";
    text += `[Assistant tool calls: ${JSON.stringify(message.tool_calls)}]`;
  }
  if (message?.role === "tool") {
    const label = message.name || message.tool_call_id || "tool";
    text = `[Tool result ${label}]\n${text}`;
  }
  return text;
}

function escapeHistoryBoundary(text) {
  return text.replaceAll("</conversation_history>", "&lt;/conversation_history&gt;");
}

function escapeSystemBoundary(text) {
  return text.replaceAll("</system_instructions>", "&lt;/system_instructions&gt;");
}

function translateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw requestError("Request body must be a JSON object");
  }
  const resolvedModel = resolveModelId(body.model);
  if (!resolvedModel) {
    throw requestError(`Unknown model '${body.model}'. Available: ${[...MODELS.keys()].join(", ")}`);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw requestError("messages must be a non-empty array");
  }

  const systemParts = [];
  const conversation = [];
  for (let messageIndex = 0; messageIndex < body.messages.length; messageIndex += 1) {
    const message = body.messages[messageIndex];
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "user";
    const text = messageText(message, messageIndex);
    if (role === "system" || role === "developer") {
      if (text) systemParts.push(text);
    } else {
      conversation.push({ role, text });
    }
  }
  if (conversation.length === 0) throw requestError("At least one non-system message is required");

  const latest = conversation.at(-1);
  const earlier = conversation.slice(0, -1);
  let prompt = "";
  // agy has no --append-system-prompt equivalent, so the OpenClaw system
  // prompt travels as a tagged block at the head of the one-shot prompt.
  if (systemParts.length > 0) {
    prompt += `<system_instructions>\n${escapeSystemBoundary(systemParts.join("\n\n"))}\n</system_instructions>\n\n`;
  }
  if (earlier.length > 0) {
    prompt += "<conversation_history>\n";
    for (const { role, text } of earlier) {
      prompt += `${role}: ${escapeHistoryBoundary(text)}\n\n`;
    }
    prompt += "</conversation_history>\n\nContinue this conversation naturally. Respond to the latest message.\n\n";
  }
  if (latest.role !== "user") prompt += `${latest.role}: `;
  prompt += latest.text || "Continue the conversation.";

  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > MAX_PROMPT_BYTES) {
    // Wording matters: OpenClaw classifies context overflow from the error text
    // (isLikelyContextOverflowError), not the status code. It needs a "signal"
    // word (prompt/input/context/token) AND an "action" word (exceeds/maximum/
    // limit/too large). Verified against the shipped classifier -- drop those
    // and this degrades to an unclassified provider error instead of failover.
    throw requestError(
      `Prompt exceeds the Antigravity CLI maximum input size: ${promptBytes} UTF-8 bytes ` +
        `is over the ${MAX_PROMPT_BYTES} byte maximum. agy would silently truncate ` +
        `the input and answer from a partial transcript.`,
      413,
    );
  }

  const modelMeta = MODELS.get(resolvedModel.base);
  const effort = mapEffort(body.reasoning_effort ?? body.reasoning?.effort, resolvedModel.suffixEffort, modelMeta);
  const baseModel = modelMeta?.agyModel || resolvedModel.base;
  const jsonSchema = parseResponseFormat(body);
  return {
    model: baseModel,
    agyModelId: `${baseModel}-${effort}`,
    clientModel: resolvedModel.base,
    effort,
    requestedEffort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
    prompt,
    requesterSessionKey: extractRequesterSessionKey(systemParts.join("\n\n")),
    allowedTools: resolveAllowedTools(body, KNOWN_TOOLS),
    jsonSchema: jsonSchema ? JSON.stringify(jsonSchema) : null,
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
  };
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function extractRequesterSessionKey(prompt) {
  const match = prompt.match(/\bsession=(agent:[^\s)\]}>,;]+)/);
  return match?.[1]?.replace(/[.!?。！？]+$/, "");
}

function cliEnvironment(requesterSessionKey, allowedTools) {
  const env = { ...process.env };
  env.OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS = String(
    process.env.OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS || EXEC_MAX_TIMEOUT_MS,
  );
  if (requesterSessionKey) env.OPENCLAW_REQUESTER_SESSION_KEY = requesterSessionKey;
  else delete env.OPENCLAW_REQUESTER_SESSION_KEY;
  applyAllowedToolsEnv(env, allowedTools);
  return env;
}

function createAgyProcess(job) {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", job.agyModelId,
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--print-timeout", `${Math.ceil(TIMEOUT_MS / 1000) + 60}s`,
  ];
  if (job.jsonSchema) args.push("--json-schema", job.jsonSchema);
  const child = spawn(AGY_BIN, args, {
    detached: true,
    cwd: AGY_CWD,
    env: cliEnvironment(job.requesterSessionKey, job.allowedTools),
    stdio: ["pipe", "pipe", "pipe"],
  });
  // agy can exit before draining stdin (auth/network failure inside the
  // binary); the pending stdin write then emits EPIPE, which used to crash
  // the whole gateway and kill every in-flight request. Swallow it here —
  // the close handler reports the real failure to the caller.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  child.stdin.end(`${JSON.stringify({
    event: "user",
    message: { role: "user", content: [{ type: "text", text: job.prompt }] },
  })}\n`);
  return child;
}

function sanitizeError(text) {
  return String(text || "")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s]+/gi, "$1[REDACTED]")
    .slice(-6000);
}

// agy 1.2.6+ prints a structured `AGY_ERROR: {...}` line on stderr for
// headless failures (canonical status, retryability). Parse it when present
// so quota/rate failures surface to OpenClaw as 429 (fast failover) instead
// of a generic 502; the original message text is always preserved.
function parseAgyError(stderrText) {
  const match = String(stderrText || "").match(/AGY_ERROR:\s*(\{[^\n]*\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function cliFailure(message, resultEvent, stderrText) {
  const text = sanitizeError(message) || "Antigravity CLI failed";
  const structured = parseAgyError(stderrText);
  const haystack = `${text} ${JSON.stringify(structured || {})}`;
  const error = new Error(text);
  if (/quota|rate.?limit|usage.?limit|too many requests|resource.?exhausted|\b429\b/i.test(haystack)) {
    error.code = "AGY_CLI_QUOTA";
    error.statusCode = 429;
  } else if (/invalid model selection|not recognized as a known model/i.test(haystack)) {
    error.code = "AGY_CLI_MODEL_REJECTED";
    error.statusCode = 502;
  } else {
    error.code = "AGY_CLI_ERROR";
    error.statusCode = 502;
  }
  if (structured) error.agyError = structured;
  error.resultEvent = resultEvent;
  return error;
}

// With --json-schema, agy's free-form response text can carry extra
// toolAction/toolSummary fields; structured_output is the clean,
// schema-shaped value and always wins when a schema was requested.
function finalResponseText(job, result) {
  if (job.jsonSchema && result?.structured_output !== undefined) {
    return JSON.stringify(result.structured_output);
  }
  return typeof result?.response === "string" ? result.response : "";
}

// agy tool steps carry tool_info {name, parameters, output}; MCP calls arrive
// as a generic call_mcp_tool whose parameters name the real server.tool and
// its Arguments — unwrap those so the log shows "openclaw.exec(command=...)"
// instead of an opaque "call_mcp_tool".
function describeToolStep(step) {
  const info = step.tool_info && typeof step.tool_info === "object" ? step.tool_info : {};
  const parameters = info.parameters && typeof info.parameters === "object" ? info.parameters : null;
  let name = info.name || step.tool_name || step.name || "unknown";
  let args = parameters;
  let via = null;
  if (name === "call_mcp_tool" && parameters && parameters.ServerName && parameters.ToolName) {
    name = `${parameters.ServerName}.${parameters.ToolName}`;
    args = parameters.Arguments ?? null;
    via = "call_mcp_tool";
  }
  const argsText = args === null || args === undefined
    ? null
    : truncateText(args, 400);
  return {
    name,
    via,
    args: argsText,
    output: info.output === undefined || info.output === null ? null : truncateText(info.output, 300),
    error: info.error === undefined || info.error === null ? null : truncateText(info.error, 300),
    durationMs: Number.isFinite(step.duration_seconds) ? Math.round(step.duration_seconds * 1000) : null,
  };
}

function runAgy(job, callbacks) {
  return new Promise((resolve, reject) => {
    const child = createAgyProcess(job);
    let stdoutBuffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let stderr = "";
    let resultEvent;
    let settled = false;
    let lastOutputAt = Date.now();
    let textOut = "";
    // Per-model-call usage from step_update; result.usage is their sum.
    let firstCallUsage = null;
    let lastCallUsage = null;

    const cleanup = createCliProcessCleanup(child, { onForcedClose: error => finish(error) });
    const failure = (message, code, statusCode = 504) => Object.assign(new Error(message), { code, statusCode });
    const timer = setTimeout(() => cleanup.terminate(failure(
      `Antigravity CLI timed out after ${TIMEOUT_MS / 1000} seconds`, 'AGY_CLI_TIMEOUT',
    )), TIMEOUT_MS);
    timer.unref();

    // Stream-stall watchdog: agy 1.1.26 can lose the model connection
    // mid-response and then emit nothing forever while background polls keep
    // the process alive. Any stdout line (init/step_update/result) refreshes
    // this timer.
    const stallInterval = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastOutputAt < STALL_TIMEOUT_MS) return;
      cleanup.terminate(failure(`Antigravity CLI stalled: no output for ${STALL_TIMEOUT_MS / 1000} seconds`, 'AGY_CLI_STALL'));
    }, Math.min(STALL_TIMEOUT_MS, 5000));
    stallInterval.unref();

    // Success no longer waits for process exit: newer agy versions linger
    // (or hang) after the result event. The result is authoritative, so
    // resolve immediately and reap the child after a short grace.
    let lingerTimer = null;
    const reapChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      lingerTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        callbacks.onLingerKill?.(resultEvent);
        cleanup.terminate();
      }, 10_000);
      lingerTimer.unref();
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(stallInterval);
      if (lingerTimer) clearTimeout(lingerTimer);
      if (error) reject(error);
      else resolve(firstCallUsage ? { ...value, firstCallUsage, lastCallUsage } : value);
    };

    child.on("error", (error) => { cleanup.dispose(); finish(error); });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.stdout.on("data", (chunk) => {
      if (settled || cleanup.error) return;
      lastOutputAt = Date.now();
      stdoutBuffer += stdoutDecoder.write(chunk);
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const kind = event?.event;
        if (kind === "init") {
          callbacks.onInit?.({ ...(event.init || {}), conversationId: event.conversation_id || event.init?.conversation_id || null });
        } else if (kind === "step_update") {
          const step = event.step_update || {};
          if (step.step_type === "agent_response" && step.usage && typeof step.usage === "object") {
            firstCallUsage ??= step.usage;
            lastCallUsage = step.usage;
          }
          if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
            textOut += step.text_delta;
            callbacks.onText?.(step.text_delta);
          } else if (step.step_type === "tool") {
            const info = describeToolStep(step);
            if (step.state === "ACTIVE") callbacks.onToolStart?.(info);
            else if (step.state === "DONE") callbacks.onToolDone?.(info);
            else if (step.state === "ERROR") callbacks.onToolError?.(info);
          }
        } else if (kind === "result") {
          resultEvent = event.result || {};
          callbacks.onResult?.(resultEvent);
          if (resultEvent.status === "SUCCESS" && !resultEvent.error) {
            finish(null, resultEvent);
            reapChild();
          } else {
            finish(cliFailure(resultEvent.error || `agy result status: ${resultEvent.status || 'missing'}`, resultEvent, stderr));
            reapChild();
          }
        }
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(lingerTimer);
      if (cleanup.error) return finish(cleanup.error);
      if (resultEvent && resultEvent.status === "SUCCESS" && !resultEvent.error) {
        return finish(null, resultEvent);
      }
      const detail = sanitizeError(
        resultEvent?.error
          ? `agy: ${resultEvent.error}`
          : resultEvent?.response
            ? undefined
            : stderr
              || `agy exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
      );
      return finish(cliFailure(detail || `agy result status: ${resultEvent?.status || "missing"}`, resultEvent, stderr));
    });

    callbacks.onChild?.(child, () => cleanup.terminate(failure('Request cancelled', 'AGY_CLI_CANCELLED', 499)));
  });
}

function writeSSE(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function streamChunk(id, created, model, delta, finishReason = null, usage) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: usage ? [] : [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

async function handleChatCompletion(req, res, body) {
  const job = translateRequest(body);
  const requestUuid = crypto.randomUUID();
  const requestId = requestUuid.slice(0, 8);
  const id = `chatcmpl-agy-cli-${requestUuid}`;
  const created = Math.floor(Date.now() / 1000);
  const queuedAt = Date.now();
  if (activeRequests >= MAX_CONCURRENT) {
    writeLiveLog(requestId, "queued", {
      model: job.model,
      session: job.requesterSessionKey || null,
      active: activeRequests,
      queued: waiters.length + 1,
      timeoutMs: QUEUE_TIMEOUT_MS,
    });
  }
  const queuedController = new AbortController();
  const cancelQueued = () => queuedController.abort();
  req.on('aborted', cancelQueued);
  res.on('close', cancelQueued);
  if (req.aborted || res.destroyed) cancelQueued();
  let release;
  try {
    release = await acquireSlot(AbortSignal.any([queuedController.signal, shutdownController.signal]));
  } catch (error) {
    writeLiveLog(requestId, "queue_timeout", {
      model: job.model,
      session: job.requesterSessionKey || null,
      queuedMs: Date.now() - queuedAt,
      code: error?.code || "AGY_CLI_QUEUE_TIMEOUT",
    });
    throw error;
  } finally {
    req.removeListener('aborted', cancelQueued);
    res.removeListener('close', cancelQueued);
  }
  if (queuedController.signal.aborted || shutdownController.signal.aborted || res.destroyed) { release(); return; }
  const queuedMs = Date.now() - queuedAt;
  const startedAt = Date.now();
  let cancelChild;
  let finished = false;
  let cancelLogged = false;

  writeLiveLog(requestId, "start", {
    requestUuid,
    model: job.model,
    agyModelId: job.agyModelId,
    effort: job.effort,
    requestedEffort: job.requestedEffort,
    session: job.requesterSessionKey || null,
    tools: job.allowedTools === null ? "all" : job.allowedTools,
    structuredOutput: Boolean(job.jsonSchema),
    stream: job.stream,
    promptChars: job.prompt.length,
    queued: waiters.length,
    queuedMs,
  });

  const logCallbacks = {
    onChild: (_value, cancel) => { cancelChild = cancel; },
    onInit: (init) => {
      writeLiveLog(requestId, "init", {
        conversationId: init.conversationId || null,
        model: init.model || job.model,
        permissionMode: init.permission_mode || null,
        toolCount: Array.isArray(init.tools) ? init.tools.length : null,
      });
    },
    onText: (text) => {
      if (text) writeLiveLog(requestId, "text", { text });
    },
    onToolStart: (info) => writeLiveLog(requestId, "tool", {
      name: info.name,
      via: info.via,
      args: info.args,
    }),
    onToolDone: (info) => writeLiveLog(requestId, "tool_done", {
      name: info.name,
      durationMs: info.durationMs,
      output: info.output,
    }),
    onToolError: (info) => writeLiveLog(requestId, "tool_error", {
      name: info.name,
      error: info.error,
      args: info.args,
    }),
    onResult: (result) => writeLiveLog(requestId, "result_arrived", {
      status: result?.status || null,
      responseChars: typeof result?.response === "string" ? result.response.length : null,
    }),
    onLingerKill: () => writeLiveLog(requestId, "linger_kill", {}),
  };

  const logDone = (result, extra = {}) => {
    writeLiveLog(requestId, "done", {
      requestUuid,
      usageSchema: "agy-output-includes-thinking-v1",
      model: job.clientModel || job.model, usageScope: "request", usageComplete: true,
      ...estimateUsageCost("antigravity-cli-gateway", job.clientModel || job.model, normalizedUsage(result?.usage)),
      conversationId: result?.conversation_id || null,
      durationMs: Date.now() - startedAt,
      usage: normalizedUsage(result?.usage),
      ...(result?.usage ? { usage_raw: rawUsage(result.usage) } : {}),
      // What OpenClaw was told; see contextAgyUsage.
      ...(result?.firstCallUsage ? {
        usage_reported: contextAgyUsage(result.firstCallUsage, result.usage),
        lastCallUsage: rawUsage(result.lastCallUsage),
      } : {}),
      ...extra,
    });
  };

  const logError = (error) => {
    writeLiveLog(requestId, "error", {
      durationMs: Date.now() - startedAt,
      code: error?.code || "agy_cli_error",
      ...(error?.resultEvent?.usage ? { usage: normalizedUsage(error.resultEvent.usage), usage_raw: rawUsage(error.resultEvent.usage), usageScope: "request" } : {}),
      message: sanitizeError(error?.message || String(error)),
    });
  };

  const cancel = () => {
    if (!finished && cancelChild) {
      if (!cancelLogged) {
        cancelLogged = true;
        writeLiveLog(requestId, "cancel", { durationMs: Date.now() - startedAt });
      }
      cancelChild();
    }
  };
  runningCancels.add(cancel);
  req.on("aborted", cancel);
  res.on("close", cancel);

  const responseModel = job.clientModel || job.model;

  try {
    if (job.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      writeSSE(res, streamChunk(id, created, responseModel, { role: "assistant", content: "" }));

      let emittedText = "";
      let heartbeats = 0;
      let lastWriteAt = Date.now();
      let streamClosed = false;
      const sse = (chunk) => {
        if (res.destroyed || streamClosed) return;
        lastWriteAt = Date.now();
        writeSSE(res, chunk);
      };
      // Progress signal for OpenClaw's stuck-session watchdog; see
      // HEARTBEAT_IDLE_MS. reasoning_content lands in the thinking channel,
      // never in the visible reply.
      const heartbeat = (note) => {
        if (res.destroyed || streamClosed) return;
        heartbeats += 1;
        sse(streamChunk(id, created, responseModel, { reasoning_content: `${note}\n` }));
      };
      const idleTimer = HEARTBEAT_IDLE_MS > 0
        ? setInterval(() => {
          if (Date.now() - lastWriteAt < HEARTBEAT_IDLE_MS) return;
          heartbeat(`[gateway heartbeat ${Math.round((Date.now() - startedAt) / 1000)}s]`);
        }, Math.max(5000, Math.min(30000, Math.floor(HEARTBEAT_IDLE_MS / 2))))
        : null;
      idleTimer?.unref();
      let result;
      try {
        result = await runAgy(job, {
          ...logCallbacks,
          onToolStart: (info) => {
            logCallbacks.onToolStart(info);
            heartbeat(`[tool ${info.name}]`);
          },
          onToolDone: (info) => {
            logCallbacks.onToolDone(info);
            heartbeat(`[tool✓ ${info.name} ${info.durationMs ?? "?"}ms]`);
          },
          onToolError: (info) => {
            logCallbacks.onToolError(info);
            heartbeat(`[tool_error ${info.name}]`);
          },
          onText: (text) => {
            logCallbacks.onText(text);
            if (!text || res.destroyed) return;
            // Structured output is delivered once, whole, from the verified
            // final result below; step text around it is not schema-clean.
            if (job.jsonSchema) return;
            emittedText += text;
            sse(streamChunk(id, created, responseModel, { content: text }));
          },
        });
        const finalText = finalResponseText(job, result);
        if (!emittedText && finalText) {
          emittedText = finalText;
          logCallbacks.onText(finalText);
          sse(streamChunk(id, created, responseModel, { content: finalText }));
        }
        sse(streamChunk(id, created, responseModel, {}, "stop"));
        if (job.includeUsage) {
          sse(streamChunk(id, created, responseModel, {}, null, contextAgyUsage(result.firstCallUsage, result.usage)));
        }
        logDone(result, heartbeats ? { heartbeats } : {}, emittedText ? {} : { emptyResponse: true });
      } catch (error) {
        logError(error);
        if (!res.destroyed) writeSSE(res, openAIError(error.message, "server_error", error.code || "agy_cli_error"));
      } finally {
        streamClosed = true;
        if (idleTimer) clearInterval(idleTimer);
      }
      if (!res.destroyed) res.end("data: [DONE]\n\n");
    } else {
      try {
        const result = await runAgy(job, logCallbacks);
        const finalText = finalResponseText(job, result);
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: responseModel,
          choices: [{
            index: 0,
            message: { role: "assistant", content: finalText },
            finish_reason: "stop",
          }],
          usage: contextAgyUsage(result.firstCallUsage, result.usage),
        });
        logDone(result, finalText ? {} : { emptyResponse: true });
      } catch (error) {
        logError(error);
        throw error;
      }
    }
  } finally {
    finished = true;
    runningCancels.delete(cancel);
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
    release();
  }
}

const cliVersion = createCliVersionProbe(AGY_BIN);

fs.mkdirSync(AGY_CWD, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const version = await cliVersion();
      return sendJson(res, version ? 200 : 503, {
        status: version ? "ok" : "degraded",
        agyCli: version,
        activeRequests,
        queuedRequests: waiters.length,
        maxConcurrent: MAX_CONCURRENT,
        queueTimeoutSeconds: Math.round(QUEUE_TIMEOUT_MS / 1000),
        timeoutSeconds: Math.round(TIMEOUT_MS / 1000),
        stallTimeoutSeconds: STALL_TIMEOUT_MS / 1000,
        processGroupCleanup: true,
        cleanupDeadlineSeconds: 6,
        execMaxTimeoutMs: EXEC_MAX_TIMEOUT_MS,
        maxPromptBytes: MAX_PROMPT_BYTES,
        reasoningEfforts: EFFORTS,
        outputTokenLimitEnforced: false,
        structuredOutput: true,
        permissionMode: "dangerously-skip-permissions",
        multimodal: { input: ["text"] },
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, {
        object: "list",
        data: [...MODELS.values()].map((model) => ({
          id: model.id, object: "model", created: model.created,
          owned_by: "google-via-antigravity-cli",
          input: model.input, reasoning: model.reasoning,
          reasoning_efforts: model.agyEfforts,
        })),
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!requireAuth(req)) return sendJson(res, 401, openAIError("Invalid API key", "authentication_error"));
      const body = await readJson(req);
      return await handleChatCompletion(req, res, body);
    }
    return sendJson(res, 404, openAIError("Not found", "invalid_request_error", "not_found"));
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed) {
        writeSSE(res, openAIError(error.message, "server_error", error.code || "internal_error"));
        res.end("data: [DONE]\n\n");
      }
      return;
    }
    const status = error.statusCode || 502;
    const type = status >= 500 ? "server_error" : "invalid_request_error";
    return sendJson(res, status, openAIError(error.message, type, error.code || null));
  }
});

server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  process.stdout.write(`[antigravity-cli-gateway] listening on http://${HOST}:${PORT}; concurrency=${MAX_CONCURRENT}; queue-timeout=${QUEUE_TIMEOUT_MS / 1000}s; timeout=${TIMEOUT_MS / 1000}s; exec-max-timeout=${EXEC_MAX_TIMEOUT_MS / 1000}s\n`);
});

function shutdown(signal) {
  process.stdout.write(`[antigravity-cli-gateway] received ${signal}, shutting down\n`);
  shutdownController.abort();
  for (const cancel of runningCancels) cancel();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
