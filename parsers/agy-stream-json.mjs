#!/usr/bin/env node
// Standalone parser for Antigravity CLI (`agy`) headless print-mode output.
//
//   echo '{"event":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}' \
//     | agy --input-format stream-json --output-format stream-json \
//         --dangerously-skip-permissions --model gemini-3.8-flash \
//     | node agy-stream-json.mjs
//
// Emits normalized events, one JSON object per line:
//   {"type":"init","model":...,"permissionMode":...,"toolCount":N}
//   {"type":"text","text":"..."}        one delta per COMPLETED agent step
//   {"type":"tool_start","name":"openclaw.exec","via":"call_mcp_tool","args":...}
//   {"type":"tool_done","name":...,"durationMs":N,"output":"..."}
//   {"type":"tool_error","name":...,"error":"..."}
//   {"type":"result","status":...,"text":...,"isError":bool,"hasFullText":bool,"usage":{...}}
//
// Protocol notes (agy 1.1.24–1.1.26):
//   • Top-level key is "event" (claude uses "type") with the payload nested
//     under the same name: {"event":"step_update","step_update":{...}}.
//   • Text arrives per finished step, not per token; nothing is emitted while
//     tools run — stream consumers need their own liveness heartbeat.
//   • Tool steps carry tool_info {name, parameters, output}; MCP calls arrive
//     as a generic call_mcp_tool whose parameters name the real
//     server.tool + Arguments — unwrapped here to "server.tool".
//   • input-format stream-json accepts ONLY text content blocks (images are
//     rejected) and uses {"event":"user","message":{...}} like claude.
//   • result may be status ERROR ("The stream was interrupted...") while still
//     carrying partial prose. Only SUCCESS establishes a finished answer.
//   • usage: input_tokens EXCLUDES cache_read_tokens;
//     output_tokens ALREADY includes thinking_tokens (verified agy 1.2.0
//     ModelUsageStats: output = thinking + response). Do not add it twice.

import readline from "node:readline";
import { rawAgyUsage } from "../lib/cli-output.mjs";

export function makeAgyStreamParser({ onEvent }) {
  let buffer = "";
  return {
    write(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) parseLine(line, onEvent);
      }
    },
    end() {
      const line = buffer.trim();
      buffer = "";
      if (line) parseLine(line, onEvent);
    },
  };
}

function parseLine(line, emit) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const kind = event?.event;
  if (kind === "init") {
    const init = event.init || {};
    emit({
      type: "init",
      model: init.model,
      permissionMode: init.permission_mode,
      toolCount: Array.isArray(init.tools) ? init.tools.length : null,
    });
  } else if (kind === "step_update") {
    const step = event.step_update || {};
    if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
      emit({ type: "text", text: step.text_delta });
    } else if (step.step_type === "tool") {
      const info = describeToolStep(step);
      if (step.state === "ACTIVE") emit({ type: "tool_start", ...info });
      else if (step.state === "DONE") emit({ type: "tool_done", ...info });
      else if (step.state === "ERROR") emit({ type: "tool_error", ...info });
    }
  } else if (kind === "result") {
    const result = event.result || {};
    const text = typeof result.response === "string" ? result.response : null;
    emit({
      type: "result",
      status: result.status,
      text,
      isError: result.status !== "SUCCESS" || Boolean(result.error),
      error: result.error || null,
      // Text on a failed result is diagnostic, never verified completion.
      hasFullText: result.status === "SUCCESS" && !result.error && Boolean(text && text.trim()),
      hasText: Boolean(text && text.trim()),
      usage: normalizeUsage(result.usage),
    });
  }
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function describeToolStep(step) {
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
  return {
    name,
    via,
    args: args === null || args === undefined ? null
      : truncate(typeof args === "string" ? args : JSON.stringify(args), 400),
    output: info.output === undefined || info.output === null ? null : truncate(info.output, 300),
    error: info.error === undefined || info.error === null ? null : truncate(info.error, 300),
    durationMs: Number.isFinite(step.duration_seconds) ? Math.round(step.duration_seconds * 1000) : null,
  };
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = rawAgyUsage(usage);
  const input = raw.input_tokens;
  const cr = raw.cache_read_tokens;
  const output = raw.output_tokens;
  const thinking = raw.thinking_tokens;
  return {
    fresh: input,             // input EXCLUDES cache_read
    cache_read: cr,
    output, thinking,
    prompt_total: input + cr,
    output_total: output,
  };
}

// ---------- CLI filter mode ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = readline.createInterface({ input: process.stdin });
  const human = process.argv.includes("--human");
  const parser = makeAgyStreamParser({
    onEvent: (e) => {
      if (human) {
        if (e.type === "text") process.stdout.write(e.text);
        else if (e.type === "tool_start") console.error(`[tool] ${e.name}${e.via ? ` (via ${e.via})` : ""} ${e.args ?? ""}`);
        else if (e.type === "tool_done") console.error(`[tool✓] ${e.name} ${e.durationMs ?? "?"}ms → ${e.output ?? ""}`);
        else if (e.type === "tool_error") console.error(`[tool✗] ${e.name}: ${e.error ?? ""}`);
        else if (e.type === "init") console.error(`[init] model=${e.model} permissions=${e.permissionMode} tools=${e.toolCount}`);
        else if (e.type === "result") console.error(`[result] ${e.status}${e.isError ? ` error=${e.error}` : ""}${e.hasFullText ? ` (${e.text.length} chars)` : ""} usage=${JSON.stringify(e.usage)}`);
      } else {
        console.log(JSON.stringify(e));
      }
    },
  });
  rl.on("line", (line) => parser.write(line + "\n"));
  rl.on("close", () => {
    parser.end();
    if (human) process.stdout.write("\n");
  });
}
