#!/usr/bin/env node
// Standalone parser for Claude Code CLI `--output-format stream-json` output.
//
//   claude -p --input-format stream-json --output-format stream-json --verbose \
//     ... < prompt.ndjson | node claude-stream-json.mjs
//
// Emits normalized events, one JSON object per line:
//   {"type":"init","model":...}
//   {"type":"text","text":"..."}          incremental answer text
//   {"type":"thinking","text":"..."}      thinking-channel deltas
//   {"type":"tool_use","id":...,"name":...,"input":{...}}
//   {"type":"tool_result","count":N}      CLI fed tool results back to the model
//   {"type":"result","subtype":...,"text":...,"usage":{...},"isError":bool}
//
// Dependency-free; usable as a CLI filter or imported as a module:
//   import { makeClaudeStreamParser } from "./claude-stream-json.mjs";
//   const parser = makeClaudeStreamParser({ onEvent: (e) => ... });
//   parser.write(chunk); parser.end();

import readline from "node:readline";

export function makeClaudeStreamParser({ onEvent }) {
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
    end() { /* final partial line without newline */
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
    return; // non-JSON noise on stdout is ignored
  }
  if (!event || typeof event !== "object") return;

  // Progress deltas arrive wrapped as {type:"stream_event", event:{...}} —
  // the Anthropic Messages SSE shape inlined into NDJSON.
  if (event.type === "stream_event") {
    const inner = event.event || {};
    if (inner.type === "content_block_start") {
      const block = inner.content_block || {};
      if (block.type === "tool_use") {
        emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    } else if (inner.type === "content_block_delta") {
      const delta = inner.delta || {};
      if (delta.type === "text_delta" && delta.text) emit({ type: "text", text: delta.text });
      else if (delta.type === "thinking_delta" && delta.thinking) emit({ type: "thinking", text: delta.thinking });
    }
    return;
  }

  // Tool results come back as {type:"user", message:{content:[tool_result,...]}}
  if (event.type === "user") {
    const content = event.message?.content;
    const toolResults = Array.isArray(content)
      ? content.filter((block) => block?.type === "tool_result").length
      : 0;
    if (toolResults > 0) emit({ type: "tool_result", count: toolResults });
    return;
  }

  // The final envelope. `result` carries the complete answer text, subtype
  // success/error, and usage with the true cache split (input_tokens here
  // EXCLUDES cache_creation/cache_read — sum them for the full prompt).
  if (event.type === "result") {
    emit({
      type: "result",
      subtype: event.subtype,
      text: typeof event.result === "string" ? event.result : null,
      isError: event.is_error === true,
      usage: normalizeUsage(event.usage),
    });
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const fresh = Number(usage.input_tokens || 0);
  const cw = Number(usage.cache_creation_input_tokens || 0);
  const cr = Number(usage.cache_read_input_tokens || 0);
  return {
    fresh, cache_write: cw, cache_read: cr,
    prompt_total: fresh + cw + cr,
    output: Number(usage.output_tokens || 0),
  };
}

// ---------- CLI filter mode ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = readline.createInterface({ input: process.stdin });
  const human = process.argv.includes("--human");
  const parser = makeClaudeStreamParser({
    onEvent: (e) => {
      if (human) {
        if (e.type === "text") process.stdout.write(e.text);
        else if (e.type === "thinking") process.stdout.write(`\x1b[2m${e.text}\x1b[0m`);
        else if (e.type === "tool_use") console.error(`[tool] ${e.name} ${JSON.stringify(e.input ?? {}).slice(0, 120)}`);
        else if (e.type === "result") console.error(`[result] ${e.subtype}${e.isError ? " (error)" : ""} usage=${JSON.stringify(e.usage)}`);
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
