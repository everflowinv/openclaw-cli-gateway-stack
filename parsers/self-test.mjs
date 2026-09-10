#!/usr/bin/env node
// Parser self-test: feeds fixtures through both parsers and asserts the
// normalized output. Run: node parsers/self-test.mjs  (exit 0 = pass)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeClaudeStreamParser } from "./claude-stream-json.mjs";
import { makeAgyStreamParser } from "./agy-stream-json.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;

function check(name, cond, detail = "") {
  if (cond) console.log(`[PASS] ${name}`);
  else { failures += 1; console.log(`[FAIL] ${name} ${detail}`); }
}

function run(parserFactory, file) {
  const events = [];
  const parser = parserFactory({ onEvent: (e) => events.push(e) });
  parser.write(readFileSync(path.join(HERE, "fixtures", file), "utf8"));
  parser.end();
  return events;
}

// ---- claude ----
const c = run(makeClaudeStreamParser, "claude-sample.ndjson");
const cText = c.filter((e) => e.type === "text").map((e) => e.text).join("");
check("claude: text deltas concatenated", cText === "Hello worldThe command printed hi.", JSON.stringify(cText));
check("claude: thinking delta", c.some((e) => e.type === "thinking" && e.text.includes("considering")));
const cTool = c.find((e) => e.type === "tool_use");
check("claude: tool_use name+input", cTool?.name === "mcp__openclaw__exec" && cTool?.input?.command === "echo hi");
check("claude: tool_result count", c.some((e) => e.type === "tool_result" && e.count === 1));
const cRes = c.find((e) => e.type === "result");
check("claude: result success", cRes?.subtype === "success" && cRes?.isError === false);
check("claude: usage cache split", cRes?.usage?.prompt_total === 9200 && cRes?.usage?.cache_read === 8000
  && cRes?.usage?.fresh === 1000 && cRes?.usage?.cache_write === 200, JSON.stringify(cRes?.usage));

// ---- agy happy path ----
const a = run(makeAgyStreamParser, "agy-sample.ndjson");
const aText = a.filter((e) => e.type === "text").map((e) => e.text).join("");
check("agy: step text concatenated", aText === "Let me check that file.\nIt printed done.\n", JSON.stringify(aText));
check("agy: init", a.some((e) => e.type === "init" && e.model === "gemini-3.8-flash" && e.toolCount === 3));
const aView = a.find((e) => e.type === "tool_start" && e.name === "view_file");
check("agy: built-in tool args", aView?.args?.includes("/tmp/notes.md"));
const aMcp = a.find((e) => e.type === "tool_done" && e.name === "openclaw.exec");
check("agy: MCP unwrap to server.tool", aMcp?.via === "call_mcp_tool" && aMcp?.output === "done"
  && aMcp?.args?.includes("echo done") && aMcp?.durationMs === 46, JSON.stringify(aMcp));
const aRes = a.find((e) => e.type === "result");
check("agy: result success", aRes?.status === "SUCCESS" && aRes?.hasFullText === true);
check("agy: usage semantics (input excludes cache_read; thinking included in output, never added twice)",
  aRes?.usage?.fresh === 6275 && aRes?.usage?.cache_read === 8126
  && aRes?.usage?.prompt_total === 14401 && aRes?.usage?.output_total === 38,
  JSON.stringify(aRes?.usage));

// ---- agy interrupted-but-complete ----
const i = run(makeAgyStreamParser, "agy-interrupted.ndjson");
const iRes = i.find((e) => e.type === "result");
check("agy: ERROR result still carries full text", iRes?.isError === true && iRes?.hasFullText === true
  && iRes?.text === "完整答案第一段。答案第二段收尾。");

console.log(failures === 0 ? "self-test: OK" : `self-test: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
