#!/usr/bin/env node
// Antigravity CLI Gateway — OpenAI-compatible façade over `agy` print mode.
// Modeled on claude-cli-gateway/server.mjs; see README.md for differences
// (text-only input, step-granularity streaming, per-model effort suffixes).

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
// agy 1.2.0 still truncates the model-facing user message near 192000 UTF-8
// bytes, then returns SUCCESS/exit 0 without a stream-json or stderr warning.
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
const STALL_TIMEOUT_MS = numberFromEnv("AGY_CLI_GATEWAY_STALL_SECONDS", 600, 30, 3600) * 1000;
// agy streams one text_delta per completed agent step, not per token, and
// emits nothing at all while tools run. Same watchdog workaround as the
// claude gateway: reasoning_content heartbeats on tool activity and after
// idle silence. 0 disables the idle timer.
const HEARTBEAT_IDLE_MS = numberFromEnv("AGY_CLI_GATEWAY_HEARTBEAT_SECONDS", 120, 0, 3600) * 1000;
const LIVE_LOG_PREFIX = "[AGYGW]";

// One catalog entry per base model; reasoning effort arrives per-request as
// OpenAI `reasoning_effort` (OpenClaw thinking level) and maps to agy's
// `--effort low|medium|high`. Legacy suffixed ids like
// "gemini-3.8-flash-high" are still accepted and pin the effort unless the
// request overrides it.
const MODELS = new Map([
  ["gemini-3.8-flash", { id: "gemini-3.8-flash", agyModel: "gemini-3.8-flash", created: 1784851200, input: ["text"], reasoning: true }],
  ["gemini-3.1-pro-preview", { id: "gemini-3.1-pro-preview", agyModel: "gemini-3.1-pro", created: 1784851200, input: ["text"], reasoning: true }],
  ["gemini-3.1-pro", { id: "gemini-3.1-pro", agyModel: "gemini-3.1-pro", created: 1784851200, input: ["text"], reasoning: true }],
]);
const EFFORTS = ["low", "medium", "high"];
const DEFAULT_EFFORT = process.env.AGY_CLI_GATEWAY_DEFAULT_EFFORT || "low";

function resolveModelId(requested) {
  if (MODELS.has(requested)) return { base: requested, suffixEffort: null };
  for (const effort of EFFORTS) {
    if (requested.endsWith(`-${effort}`)) {
      const base = requested.slice(0, -(effort.length + 1));
      if (MODELS.has(base)) return { base, suffixEffort: effort };
    }
  }
  return null;
}

// OpenClaw levels beyond agy's three clamp upward (xhigh/max -> high) or
// downward to the cheapest real effort (none/minimal/off -> low); missing or
// unrecognized values fall back to the pinned suffix or DEFAULT_EFFORT.
function mapEffort(requested, fallbackEffort, modelMeta) {
  const value = typeof requested === "string" ? requested.toLowerCase() : "";
  if (modelMeta?.agyModel === "gemini-3.1-pro") {
    if (value === "high" || value === "xhigh" || value === "max" || value === "ultra") return "high";
    return "low";
  }
  if (EFFORTS.includes(value)) return value;
  if (value === "none" || value === "minimal" || value === "off") return "low";
  if (value === "xhigh" || value === "max" || value === "ultra") return "high";
  return fallbackEffort || DEFAULT_EFFORT;
}

let activeRequests = 0;
const waiters = [];

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

function acquireSlot() {
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
        activeRequests += 1;
        resolve(releaseSlot);
      },
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      const error = new Error(`Antigravity CLI gateway queue timed out after ${Math.round(QUEUE_TIMEOUT_MS / 1000)} seconds`);
      error.code = "AGY_CLI_QUEUE_TIMEOUT";
      error.statusCode = 503;
      reject(error);
    }, QUEUE_TIMEOUT_MS);
    timer.unref();
    waiters.push(waiter);
  });
}

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waiters.shift();
  if (next) next.grant();
}

function sendJson(res, status, body) {
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
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
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
  return {
    model: modelMeta?.agyModel || resolvedModel.base,
    clientModel: resolvedModel.base,
    effort: mapEffort(body.reasoning_effort ?? body.reasoning?.effort, resolvedModel.suffixEffort, modelMeta),
    requestedEffort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
    prompt,
    requesterSessionKey: extractRequesterSessionKey(prompt),
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
  return match?.[1];
}

function cliEnvironment(requesterSessionKey) {
  const env = { ...process.env };
  env.OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS = String(
    process.env.OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS || EXEC_MAX_TIMEOUT_MS,
  );
  if (requesterSessionKey) env.OPENCLAW_REQUESTER_SESSION_KEY = requesterSessionKey;
  else delete env.OPENCLAW_REQUESTER_SESSION_KEY;
  return env;
}

function createAgyProcess(job) {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", job.model,
    "--effort", job.effort,
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--print-timeout", `${Math.ceil(TIMEOUT_MS / 1000) + 60}s`,
  ];
  const child = spawn(AGY_BIN, args, {
    cwd: AGY_CWD,
    env: cliEnvironment(job.requesterSessionKey),
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

function normalizedUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = Number(usage.input_tokens || 0) + Number(usage.cache_read_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0) + Number(usage.thinking_tokens || 0);
  return {
    prompt_tokens: promptTokens,
    prompt_tokens_details: { cached_tokens: Number(usage.cache_read_tokens || 0) },
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

// agy reports the true cache split: input_tokens EXCLUDES cache_read_tokens
// (total = input + cache_read + output + thinking; thinking billed as output).
// Kept alongside the normalized OpenAI-style usage (prompt = input + cache_read)
// so downstream stats can price exactly.
function rawUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input_tokens: Number(usage.input_tokens || 0),
    cache_read_tokens: Number(usage.cache_read_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0),
    thinking_tokens: Number(usage.thinking_tokens || 0),
  };
}

// agy tool steps carry tool_info {name, parameters, output}; MCP calls arrive
// as a generic call_mcp_tool whose parameters name the real server.tool and
// its Arguments — unwrap those so the log shows "openclaw.exec(command=...)"
// instead of an opaque "call_mcp_tool".
function truncateText(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

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
    : truncateText(typeof args === "string" ? args : JSON.stringify(args), 400);
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
    let stderr = "";
    let resultEvent;
    let settled = false;
    let timedOut = false;
    let stalled = false;
    let lastOutputAt = Date.now();
    let textOut = "";

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TIMEOUT_MS);
    timer.unref();

    // Stream-stall watchdog: agy 1.1.26 can lose the model connection
    // mid-response and then emit nothing forever while background polls keep
    // the process alive. Any stdout line (init/step_update/result) refreshes
    // this timer.
    const stallInterval = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastOutputAt < STALL_TIMEOUT_MS) return;
      stalled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, 5000);
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
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
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
      else resolve(value);
    };

    child.on("error", (error) => finish(error));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.stdout.on("data", (chunk) => {
      lastOutputAt = Date.now();
      stdoutBuffer += chunk.toString("utf8");
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
          callbacks.onInit?.(event.init || {});
        } else if (kind === "step_update") {
          const step = event.step_update || {};
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
          } else if (typeof resultEvent.response === "string" && resultEvent.response.trim()) {
            // agy can report ERROR ("The stream was interrupted") while still
            // delivering the complete response text — a network blip at the
            // stream tail must not discard a finished answer.
            callbacks.onDegraded?.({ reason: resultEvent.error || "error-with-response", chars: resultEvent.response.length, source: "result.response" });
            finish(null, { ...resultEvent, status: "SUCCESS", error: null });
            reapChild();
          } else if (textOut.trim()) {
            callbacks.onDegraded?.({ reason: resultEvent.error || "error-with-text", chars: textOut.length, source: "streamed-text" });
            finish(null, { status: "SUCCESS", error: null, response: textOut, usage: resultEvent.usage });
            reapChild();
          }
        }
      }
    });
    child.on("close", (code, signal) => {
      if (timedOut || stalled) {
        // Timeout/stall after a hang: if the answer text already streamed
        // (the post-completion hang variant), salvage it instead of
        // discarding minutes of finished work.
        if (textOut.trim()) {
          callbacks.onDegraded?.({ reason: timedOut ? "timeout-with-text" : "stall-with-text", chars: textOut.length, source: "streamed-text" });
          return finish(null, { status: "SUCCESS", response: textOut });
        }
        if (timedOut) {
          const error = new Error(`Antigravity CLI timed out after ${Math.round(TIMEOUT_MS / 1000)} seconds`);
          error.code = "AGY_CLI_TIMEOUT";
          return finish(error);
        }
        const error = new Error(
          `Antigravity CLI stalled: no output for ${Math.round(STALL_TIMEOUT_MS / 1000)}s (stream likely dropped mid-response; last output ${Math.round((Date.now() - lastOutputAt) / 1000)}s ago)`,
        );
        error.code = "AGY_CLI_STALL";
        return finish(error);
      }
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
      const error = new Error(detail || `agy result status: ${resultEvent?.status || "missing"}`);
      error.code = "AGY_CLI_ERROR";
      error.resultEvent = resultEvent;
      return finish(error);
    });

    callbacks.onChild?.(child);
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
  let release;
  try {
    release = await acquireSlot();
  } catch (error) {
    writeLiveLog(requestId, "queue_timeout", {
      model: job.model,
      session: job.requesterSessionKey || null,
      queuedMs: Date.now() - queuedAt,
      code: error?.code || "AGY_CLI_QUEUE_TIMEOUT",
    });
    throw error;
  }
  const queuedMs = Date.now() - queuedAt;
  const startedAt = Date.now();
  let child;
  let finished = false;
  let cancelLogged = false;

  writeLiveLog(requestId, "start", {
    model: job.model,
    effort: job.effort,
    requestedEffort: job.requestedEffort,
    session: job.requesterSessionKey || null,
    stream: job.stream,
    promptChars: job.prompt.length,
    queued: waiters.length,
    queuedMs,
  });

  const logCallbacks = {
    onChild: (value) => { child = value; },
    onInit: (init) => {
      writeLiveLog(requestId, "init", {
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
    onDegraded: (info) => writeLiveLog(requestId, "degraded", info),
    onLingerKill: () => writeLiveLog(requestId, "linger_kill", {}),
  };

  const logDone = (result, extra = {}) => {
    writeLiveLog(requestId, "done", {
      durationMs: Date.now() - startedAt,
      usage: normalizedUsage(result?.usage),
      ...(result?.usage ? { usage_raw: rawUsage(result.usage) } : {}),
      ...extra,
    });
  };

  const logError = (error) => {
    writeLiveLog(requestId, "error", {
      durationMs: Date.now() - startedAt,
      code: error?.code || "agy_cli_error",
      message: sanitizeError(error?.message || String(error)),
    });
  };

  const cancel = () => {
    if (!finished && child && child.exitCode === null && child.signalCode === null) {
      if (!cancelLogged) {
        cancelLogged = true;
        writeLiveLog(requestId, "cancel", { durationMs: Date.now() - startedAt });
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }
  };
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
            emittedText += text;
            sse(streamChunk(id, created, responseModel, { content: text }));
          },
        });
        if (!emittedText && typeof result.response === "string" && result.response) {
          emittedText = result.response;
          logCallbacks.onText(result.response);
          sse(streamChunk(id, created, responseModel, { content: result.response }));
        }
        sse(streamChunk(id, created, responseModel, {}, "stop"));
        if (job.includeUsage) {
          sse(streamChunk(id, created, responseModel, {}, null, normalizedUsage(result.usage)));
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
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: responseModel,
          choices: [{
            index: 0,
            message: { role: "assistant", content: result.response || "" },
            finish_reason: "stop",
          }],
          usage: normalizedUsage(result.usage),
        });
        logDone(result, result.response ? {} : { emptyResponse: true });
      } catch (error) {
        logError(error);
        throw error;
      }
    }
  } finally {
    finished = true;
    release();
  }
}

function cliVersion() {
  const result = spawnSync(AGY_BIN, ["--version"], { encoding: "utf8", timeout: 15000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

fs.mkdirSync(AGY_CWD, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const version = cliVersion();
      return sendJson(res, version ? 200 : 503, {
        status: version ? "ok" : "degraded",
        agyCli: version,
        activeRequests,
        queuedRequests: waiters.length,
        maxConcurrent: MAX_CONCURRENT,
        queueTimeoutSeconds: Math.round(QUEUE_TIMEOUT_MS / 1000),
        execMaxTimeoutMs: EXEC_MAX_TIMEOUT_MS,
        maxPromptBytes: MAX_PROMPT_BYTES,
        multimodal: { input: ["text"] },
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, {
        object: "list",
        data: [...MODELS.values()].map((model) => ({ ...model, object: "model", owned_by: "google-via-antigravity-cli" })),
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
