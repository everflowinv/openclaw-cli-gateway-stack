#!/usr/bin/env node

import http from "node:http";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizedClaudeUsage as normalizedUsage, contextClaudeUsage } from "../lib/cli-output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.CLAUDE_CLI_GATEWAY_WORKSPACE
  || process.env.OPENCLAW_WORKSPACE
  || path.join(os.homedir(), ".openclaw", "workspace");
const HOST = process.env.CLAUDE_CLI_GATEWAY_HOST || "127.0.0.1";
const PORT = numberFromEnv("CLAUDE_CLI_GATEWAY_PORT", 4568, 1, 65535);
const CLAUDE_BIN = process.env.CLAUDE_CLI_BIN || "claude";
const MCP_CONFIG = process.env.CLAUDE_CLI_MCP_CONFIG || path.join(HERE, "mcp.json");
const MAX_CONCURRENT = numberFromEnv("CLAUDE_CLI_GATEWAY_MAX_CONCURRENT", 4, 1, 32);
const QUEUE_TIMEOUT_MS = numberFromEnv("CLAUDE_CLI_GATEWAY_QUEUE_TIMEOUT_SECONDS", 120, 1, 3600) * 1000;
const TIMEOUT_MS = numberFromEnv("CLAUDE_CLI_GATEWAY_TIMEOUT_SECONDS", 3600, 30, 86400) * 1000;
const MAX_TURNS = numberFromEnv("CLAUDE_CLI_GATEWAY_MAX_TURNS", 200, 1, 1000);
// Hard per-call ceiling for openclaw exec/process tools. Without it the model
// may pass timeoutMs up to the proxy default of 30 min, outliving caller turn
// timeouts and turning into a silent hang that ends as an aborted request.
const EXEC_MAX_TIMEOUT_MS = numberFromEnv(
  "CLAUDE_CLI_GATEWAY_EXEC_MAX_TIMEOUT_MS",
  600000,
  1000,
  1800000,
);
// OpenClaw's decoded image allowance is 20 MiB. Base64 expands that by ~4/3,
// and the same request also carries the full system prompt and conversation.
const MAX_BODY_BYTES = numberFromEnv("CLAUDE_CLI_GATEWAY_MAX_BODY_MB", 64, 1, 256) * 1024 * 1024;
const MAX_IMAGES = numberFromEnv("CLAUDE_CLI_GATEWAY_MAX_IMAGES", 20, 1, 100);
const MAX_IMAGE_BYTES = numberFromEnv("CLAUDE_CLI_GATEWAY_MAX_IMAGE_MB", 10, 1, 50) * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = numberFromEnv("CLAUDE_CLI_GATEWAY_MAX_TOTAL_IMAGE_MB", 20, 1, 200) * 1024 * 1024;
const API_KEY = process.env.CLAUDE_CLI_GATEWAY_API_KEY || "";
// OpenClaw's stuck-session watchdog (diagnostics.stuckSessionAbortMs) only
// counts model stream events as progress, and this gateway used to forward
// text deltas only. A long run of tool calls with no prose therefore looked
// like a stalled session, got aborted, and surfaced as "exited with code 143".
// Streaming responses now emit short `reasoning_content` heartbeats on tool
// activity and after HEARTBEAT_IDLE_MS of silence. They land in the thinking
// channel (never in the visible reply); OpenClaw drops them when the request
// has thinking disabled. Set the env var to 0 to disable the idle timer.
const HEARTBEAT_IDLE_MS = numberFromEnv("CLAUDE_CLI_GATEWAY_HEARTBEAT_IDLE_SECONDS", 120, 0, 3600) * 1000;
const LIVE_LOG_PREFIX = "[CLIGW]";

const ALLOWED_IMAGE_MIMES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MODELS = new Map([
  ["claude-opus-5-5", { id: "claude-opus-5-5", created: 1790035200, input: ["text", "image"] }],
  ["claude-sonnet-5-5", { id: "claude-sonnet-5-5", created: 1790553600, input: ["text", "image"] }],
  ["claude-fable-5-1", { id: "claude-fable-5-1", created: 1788220800, input: ["text", "image"] }],
]);

// Optional isolated model lane; used for a non-interrupting Opus 5.5 rollout.
const MODEL_ALLOWLIST = String(process.env.CLAUDE_CLI_GATEWAY_MODEL_ALLOWLIST || "").split(",").map(s => s.trim()).filter(Boolean);
if (MODEL_ALLOWLIST.length) {
  for (const id of MODELS.keys()) if (!MODEL_ALLOWLIST.includes(id)) MODELS.delete(id);
  if (!MODELS.size) throw new Error("CLAUDE_CLI_GATEWAY_MODEL_ALLOWLIST selects no known models");
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
      const error = new Error(`Claude CLI gateway queue timed out after ${Math.round(QUEUE_TIMEOUT_MS / 1000)} seconds`);
      error.code = "CLAUDE_CLI_QUEUE_TIMEOUT";
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

function normalizeImageMime(value) {
  const mime = String(value || "").trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function normalizedBase64(value, label) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw requestError(`${label} contains invalid base64 data`);
  }
  return compact;
}

function registerImage(mimeValue, dataValue, tracker, label) {
  const mediaType = normalizeImageMime(mimeValue);
  if (!ALLOWED_IMAGE_MIMES.has(mediaType)) {
    throw requestError(`${label} uses unsupported MIME '${mediaType || "unknown"}'. Supported: ${[...ALLOWED_IMAGE_MIMES].join(", ")}`);
  }
  const data = normalizedBase64(dataValue, label);
  const bytes = Buffer.from(data, "base64").length;
  if (bytes === 0) throw requestError(`${label} is empty`);
  if (bytes > MAX_IMAGE_BYTES) {
    throw requestError(`${label} exceeds the per-image limit of ${MAX_IMAGE_BYTES} bytes`);
  }
  tracker.count += 1;
  tracker.totalBytes += bytes;
  if (tracker.count > MAX_IMAGES) throw requestError(`Too many images (${tracker.count}; limit ${MAX_IMAGES})`);
  if (tracker.totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw requestError(`Images exceed the total decoded limit of ${MAX_TOTAL_IMAGE_BYTES} bytes`);
  }
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

function imageFromDataUri(value, tracker, label) {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is.exec(String(value || ""));
  if (!match) {
    if (/^https?:\/\//i.test(String(value || ""))) {
      throw requestError(`${label} is a remote URL. OpenClaw-compatible image input must be an inline base64 data URI`);
    }
    throw requestError(`${label} must be a base64 image data URI`);
  }
  return registerImage(match[1], match[2], tracker, label);
}

function imageFromBlock(block, tracker, label) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "image_url" || block.type === "input_image") {
    const imageUrl = typeof block.image_url === "string"
      ? block.image_url
      : block.image_url?.url;
    if (typeof imageUrl === "string") return imageFromDataUri(imageUrl, tracker, label);
    if (block.source?.type === "base64") {
      return registerImage(block.source.media_type, block.source.data, tracker, label);
    }
    throw requestError(`${label} is missing image_url.url`);
  }
  if (block.type !== "image") return null;
  if (block.source?.type === "base64") {
    return registerImage(block.source.media_type, block.source.data, tracker, label);
  }
  if (typeof block.url === "string") return imageFromDataUri(block.url, tracker, label);
  if (typeof block.data === "string") {
    return registerImage(block.mimeType || block.media_type, block.data, tracker, label);
  }
  throw requestError(`${label} is missing a supported image source`);
}

function pushText(blocks, value) {
  const text = String(value || "");
  if (!text) return;
  const previous = blocks.at(-1);
  if (previous?.type === "text") previous.text += text;
  else blocks.push({ type: "text", text });
}

function contentBlocks(content, tracker, messageIndex) {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [{ type: "text", text: JSON.stringify(content) }];

  const result = [];
  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const block = content[blockIndex];
    const label = `messages[${messageIndex}].content[${blockIndex}]`;
    if (typeof block === "string") {
      pushText(result, block);
    } else if ((block?.type === "text" || block?.type === "input_text") && typeof block.text === "string") {
      pushText(result, block.text);
    } else if (block?.type === "image_url" || block?.type === "input_image" || block?.type === "image") {
      result.push(imageFromBlock(block, tracker, label));
    } else if (block !== null && block !== undefined) {
      pushText(result, JSON.stringify(block));
    }
  }
  return result;
}

function messageBlocks(message, tracker, messageIndex) {
  const blocks = contentBlocks(message?.content, tracker, messageIndex);
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    pushText(blocks, `${blocks.length ? "\n" : ""}[Assistant tool calls: ${JSON.stringify(message.tool_calls)}]`);
  }
  if (message?.role === "tool") {
    const label = message.name || message.tool_call_id || "tool";
    blocks.unshift({ type: "text", text: `[Tool result ${label}]\n` });
  }
  return blocks;
}

function textOnly(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function escapeHistoryBoundary(text) {
  return text.replaceAll("</conversation_history>", "&lt;/conversation_history&gt;");
}

function appendPromptBlocks(target, blocks, { history = false, imageCounter }) {
  for (const block of blocks) {
    if (block.type === "text") {
      pushText(target, history ? escapeHistoryBoundary(block.text) : block.text);
      continue;
    }
    imageCounter.value += 1;
    pushText(target, `\n[Image ${imageCounter.value} follows]\n`);
    target.push(block);
    pushText(target, `\n[End image ${imageCounter.value}]\n`);
  }
}

function translateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw requestError("Request body must be a JSON object");
  }
  if (!MODELS.has(body.model)) {
    throw requestError(`Unknown model '${body.model}'. Available: ${[...MODELS.keys()].join(", ")}`);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw requestError("messages must be a non-empty array");
  }

  const imageTracker = { count: 0, totalBytes: 0 };
  const systemParts = [];
  const systemImages = [];
  const conversation = [];
  for (let messageIndex = 0; messageIndex < body.messages.length; messageIndex += 1) {
    const message = body.messages[messageIndex];
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "user";
    const blocks = messageBlocks(message, imageTracker, messageIndex);
    if (role === "system" || role === "developer") {
      const text = textOnly(blocks);
      if (text) systemParts.push(text);
      systemImages.push(...blocks.filter((block) => block.type === "image"));
    } else {
      conversation.push({ role, blocks });
    }
  }
  if (conversation.length === 0) throw requestError("At least one non-system message is required");

  const latest = conversation.at(-1);
  const earlier = conversation.slice(0, -1);
  const promptContent = [];
  const imageCounter = { value: 0 };
  if (systemImages.length > 0) {
    pushText(promptContent, "Images attached to system/developer context:\n");
    appendPromptBlocks(promptContent, systemImages, { history: false, imageCounter });
    pushText(promptContent, "\n");
  }
  if (earlier.length > 0) {
    pushText(promptContent, "<conversation_history>\n");
    for (const { role, blocks } of earlier) {
      pushText(promptContent, `${role}: `);
      appendPromptBlocks(promptContent, blocks, { history: true, imageCounter });
      pushText(promptContent, "\n\n");
    }
    pushText(promptContent, "</conversation_history>\n\nContinue this conversation naturally. Respond to the latest message.\n\n");
  }
  if (latest.role !== "user") pushText(promptContent, `${latest.role}: `);
  appendPromptBlocks(promptContent, latest.blocks, { history: false, imageCounter });
  if (promptContent.length === 0) pushText(promptContent, "Continue the conversation.");

  const systemPrompt = systemParts.join("\n\n");
  const requesterSessionKey = extractRequesterSessionKey(systemPrompt);
  return {
    model: body.model,
    effort: resolveEffort(body.reasoning_effort ?? body.reasoning?.effort),
    promptContent,
    systemPrompt,
    requesterSessionKey,
    imageCount: imageTracker.count,
    imageBytes: imageTracker.totalBytes,
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
  };
}

// claude -p accepts --effort low|medium|high|xhigh|max. OpenClaw's thinking
// level arrives as OpenAI reasoning_effort; none/off mean "no dial" and are
// silently ignored, anything else unknown is a hard 400.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function resolveEffort(requested) {
  if (requested === undefined || requested === null || requested === "") return null;
  const value = String(requested).toLowerCase();
  if (value === "none" || value === "off") return null;
  if (EFFORTS.includes(value)) return value;
  throw requestError(`Unsupported reasoning_effort '${requested}'. Available: ${EFFORTS.join(", ")} (or none/off to omit)`);
}

function requestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function extractRequesterSessionKey(systemPrompt) {
  const match = systemPrompt.match(/\bsession=(agent:[^\s)\]}>,;]+)/);
  return match?.[1];
}

function cliEnvironment(requesterSessionKey) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS = String(
    process.env.OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS || EXEC_MAX_TIMEOUT_MS,
  );
  if (requesterSessionKey) env.OPENCLAW_REQUESTER_SESSION_KEY = requesterSessionKey;
  else delete env.OPENCLAW_REQUESTER_SESSION_KEY;
  return env;
}

function createClaudeProcess(job) {
  const args = [
    "-p",
    "--model", job.model,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--max-turns", String(MAX_TURNS),
    "--tools", "ToolSearch",
    "--allowedTools", "mcp__openclaw__*",
    "--mcp-config", MCP_CONFIG,
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  if (job.effort) {
    args.push("--effort", job.effort);
  }
  if (job.systemPrompt) {
    args.push("--append-system-prompt-file", "/dev/fd/3");
  }

  const stdio = job.systemPrompt
    ? ["pipe", "pipe", "pipe", "pipe"]
    : ["pipe", "pipe", "pipe"];
  const child = spawn(CLAUDE_BIN, args, {
    cwd: WORKSPACE,
    env: cliEnvironment(job.requesterSessionKey),
    stdio,
  });
  // The CLI can exit before draining stdin (auth/network failure); the
  // pending stdin write then emits EPIPE, which would crash the gateway and
  // kill every in-flight request. Swallow it — the close handler reports the
  // real failure. (Same fix as antigravity-cli-gateway.)
  for (const stream of child.stdio) stream?.on?.("error", () => {});
  child.stdin.end(`${JSON.stringify({
    type: "user",
    message: { role: "user", content: job.promptContent },
  })}\n`);
  if (job.systemPrompt) child.stdio[3].end(job.systemPrompt);
  return child;
}

function sanitizeError(text) {
  return String(text || "")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s]+/gi, "$1[REDACTED]")
    .slice(-6000);
}

function runClaude(job, callbacks) {
  return new Promise((resolve, reject) => {
    const child = createClaudeProcess(job);
    let stdoutBuffer = "";
    let stderr = "";
    let resultEvent;
    let settled = false;
    let timedOut = false;
    // Per-model-call usage from assistant events; result.usage is their sum.
    let firstCallUsage = null;
    let lastCallUsage = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TIMEOUT_MS);
    timer.unref();

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    child.on("error", (error) => finish(error));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.stdout.on("data", (chunk) => {
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
        if (event.type === "stream_event") {
          const inner = event.event;
          if (inner?.type === "content_block_start") {
            callbacks.onBlockStart?.(inner.content_block || {});
          } else if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
            callbacks.onText?.(inner.delta.text || "");
          } else if (inner?.type === "content_block_delta" && inner.delta?.type === "thinking_delta") {
            callbacks.onThinking?.(inner.delta.thinking || "");
          } else if (inner?.type === "content_block_stop") {
            callbacks.onBlockStop?.();
          }
        } else if (event.type === "assistant" && event.message?.id && event.message?.usage) {
          firstCallUsage ??= event.message.usage;
          lastCallUsage = event.message.usage;
          callbacks.onUsage?.(event.message);
        } else if (event.type === "result") {
          resultEvent = event;
          callbacks.onResult?.(event);
        } else if (event.type === "user") {
          const content = event.message?.content;
          const toolResults = Array.isArray(content)
            ? content.filter((block) => block?.type === "tool_result").length
            : 0;
          if (toolResults > 0) callbacks.onToolResult?.(toolResults);
        }
      }
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        const error = new Error(`Claude CLI timed out after ${Math.round(TIMEOUT_MS / 1000)} seconds`);
        error.code = "CLAUDE_CLI_TIMEOUT";
        return finish(error);
      }
      if (resultEvent && resultEvent.subtype === "success" && resultEvent.is_error !== true) {
        return finish(null, firstCallUsage ? { ...resultEvent, firstCallUsage, lastCallUsage } : resultEvent);
      }
      const detail = sanitizeError(
        resultEvent?.result
        || resultEvent?.errors?.join?.("\n")
        || stderr
        || `Claude CLI exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
      );
      const error = new Error(detail || "Claude CLI failed without an error message");
      error.code = "CLAUDE_CLI_ERROR";
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
  const id = `chatcmpl-claude-cli-${requestUuid}`;
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
      code: error?.code || "CLAUDE_CLI_QUEUE_TIMEOUT",
    });
    throw error;
  }
  const queuedMs = Date.now() - queuedAt;
  const startedAt = Date.now();
  let child;
  let finished = false;
  let cancelLogged = false;

  writeLiveLog(requestId, "start", {
    requestUuid,
    model: job.model,
    effort: job.effort,
    session: job.requesterSessionKey || null,
    stream: job.stream,
    images: job.imageCount,
    queued: waiters.length,
    queuedMs,
  });

  const logCallbacks = {
    onChild: (value) => { child = value; },
    onThinking: (text) => {
      if (text) writeLiveLog(requestId, "thinking", { text });
    },
    onText: (text) => {
      if (text) writeLiveLog(requestId, "text", { text });
    },
    onBlockStart: (block) => {
      if (block?.type === "tool_use") {
        writeLiveLog(requestId, "tool", {
          name: block.name || "unknown",
          toolUseId: block.id || null,
        });
      }
    },
    onBlockStop: () => writeLiveLog(requestId, "block_stop"),
    onUsage: (message) => writeLiveLog(requestId, "usage", {
      requestUuid, messageId: message.id, model: message.model || job.model,
      usage: normalizedUsage(message.usage),
    }),
  };

  const logDone = (result, extra = {}) => {
    writeLiveLog(requestId, "done", {
      requestUuid,
      durationMs: Date.now() - startedAt,
      usage: normalizedUsage(result?.usage),
      // What OpenClaw was told; see contextClaudeUsage.
      usage_reported: contextClaudeUsage(result?.firstCallUsage, result?.usage),
      ...(result?.lastCallUsage ? { lastCallUsage: normalizedUsage(result.lastCallUsage) } : {}),
      ...extra,
    });
  };

  const logError = (error) => {
    writeLiveLog(requestId, "error", {
      durationMs: Date.now() - startedAt,
      code: error?.code || "claude_cli_error",
      ...(error?.resultEvent?.usage ? { usage: normalizedUsage(error.resultEvent.usage) } : {}),
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

  try {
    if (job.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      writeSSE(res, streamChunk(id, created, job.model, { role: "assistant", content: "" }));

      let emittedText = "";
      let heartbeats = 0;
      let lastWriteAt = Date.now();
      let textBlockOpen = false;
      let streamClosed = false;
      const sse = (chunk) => {
        if (res.destroyed || streamClosed) return;
        lastWriteAt = Date.now();
        writeSSE(res, chunk);
      };
      // Progress signal for OpenClaw's watchdog; see HEARTBEAT_IDLE_MS. Never
      // emitted while a text block is open so visible prose is not split.
      const heartbeat = (note) => {
        if (res.destroyed || streamClosed || textBlockOpen) return;
        heartbeats += 1;
        sse(streamChunk(id, created, job.model, { reasoning_content: `${note}\n` }));
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
        result = await runClaude(job, {
          ...logCallbacks,
          onBlockStart: (block) => {
            logCallbacks.onBlockStart(block);
            if (block?.type === "text") textBlockOpen = true;
            else if (block?.type === "tool_use") heartbeat(`[tool_use ${block.name || "unknown"}]`);
          },
          onBlockStop: () => {
            logCallbacks.onBlockStop();
            textBlockOpen = false;
          },
          onToolResult: (count) => heartbeat(`[tool_result x${count}]`),
          onText: (text) => {
            logCallbacks.onText(text);
            if (!text || res.destroyed) return;
            emittedText += text;
            sse(streamChunk(id, created, job.model, { content: text }));
          },
        });
        if (!emittedText && typeof result.result === "string" && result.result) {
          emittedText = result.result;
          logCallbacks.onText(result.result);
          sse(streamChunk(id, created, job.model, { content: result.result }));
        }
        sse(streamChunk(id, created, job.model, {}, "stop"));
        if (job.includeUsage) {
          sse(streamChunk(id, created, job.model, {}, null, contextClaudeUsage(result.firstCallUsage, result.usage)));
        }
        logDone(result, heartbeats ? { heartbeats } : {});
      } catch (error) {
        logError(error);
        if (!res.destroyed) writeSSE(res, openAIError(error.message, "server_error", error.code || "claude_cli_error"));
      } finally {
        streamClosed = true;
        if (idleTimer) clearInterval(idleTimer);
      }
      if (!res.destroyed) res.end("data: [DONE]\n\n");
    } else {
      try {
        const result = await runClaude(job, logCallbacks);
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: job.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: result.result || "" },
            finish_reason: "stop",
          }],
          usage: contextClaudeUsage(result.firstCallUsage, result.usage),
        });
        logDone(result);
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
  const result = spawnSync(CLAUDE_BIN, ["--version"], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const version = cliVersion();
      return sendJson(res, version ? 200 : 503, {
        status: version ? "ok" : "degraded",
        claudeCli: version,
        activeRequests,
        queuedRequests: waiters.length,
        maxConcurrent: MAX_CONCURRENT,
        queueTimeoutSeconds: Math.round(QUEUE_TIMEOUT_MS / 1000),
        execMaxTimeoutMs: EXEC_MAX_TIMEOUT_MS,
        multimodal: {
          input: ["text", "image"],
          imageMimes: [...ALLOWED_IMAGE_MIMES],
          maxImages: MAX_IMAGES,
          maxImageBytes: MAX_IMAGE_BYTES,
          maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES,
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, {
        object: "list",
        data: [...MODELS.values()].map((model) => ({ ...model, object: "model", owned_by: "anthropic-via-claude-cli" })),
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
  process.stdout.write(`[claude-cli-gateway] listening on http://${HOST}:${PORT}; concurrency=${MAX_CONCURRENT}; queue-timeout=${QUEUE_TIMEOUT_MS / 1000}s; timeout=${TIMEOUT_MS / 1000}s; exec-max-timeout=${EXEC_MAX_TIMEOUT_MS / 1000}s\n`);
});

function shutdown(signal) {
  process.stdout.write(`[claude-cli-gateway] received ${signal}, shutting down\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
