import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAllowedToolsEnv, parseResponseFormat, readOpenClawToolNames, readToolSearchDirectory, resolveAllowedTools } from "./openai-request.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const known = readOpenClawToolNames(path.join(HERE, "..", "openclaw-mcp-proxy", "tools-schema.json"));

test("tool schema loads with gateway and local proxy tools", () => {
  assert.ok(known.size > 40);
  assert.ok(known.has("exec"));
  assert.ok(known.has("sessions_send") || known.has("cron"));
});

test("no tools field means unrestricted; tool_choice none means empty", () => {
  assert.equal(resolveAllowedTools({}, known), null);
  assert.deepEqual(resolveAllowedTools({ tool_choice: "none", tools: [{ name: "exec" }] }, known), []);
  assert.deepEqual(resolveAllowedTools({ tools: [] }, known), []);
});

test("tool names are stripped of MCP prefixes and intersected", () => {
  const allowed = resolveAllowedTools({
    tools: [
      { function: { name: "mcp__openclaw__exec" } },
      { name: "openclaw__read" },
      { name: "mcp__gridcraft__read_range" },
      { name: "guidepoint__search" },
      { name: "not_a_real_tool" },
      { name: 42 },
      {},
    ],
  }, known);
  assert.deepEqual(allowed, ["exec", "read", "gridcraft__read_range", "guidepoint__search"]);
});

// Rendered the way OpenClaw 2026.9.9 formatToolSearchCatalogDirectory does.
const directoryPrompt = (rows, omitted) => [
  "## Tooling", "### Deferred Tool Schemas", "Available deferred-schema tools:", ...rows, "",
  "Policy-approved MCP and client tools may also be discoverable through search.",
  (omitted ? `${omitted} additional tools omitted. ` : "") + "Use tool_search to find a tool and its input signature.",
  "", "## Workspace",
].join("\n");
const toolSearchBody = { tools: ["read", "exec", "tool_search", "tool_describe", "tool_call"].map((name) => ({ function: { name } })) };

test("Tool Search runs regain the deferred catalog from the directory", () => {
  const system = directoryPrompt([
    "- web_search (core): Search current web; normalized provider...",
    "- message (core)",
    "- codex_plugins (codex): not served by the proxy",
  ], 77);
  const allowed = resolveAllowedTools(toolSearchBody, known, system);
  assert.deepEqual(allowed.slice(0, 4), ["read", "exec", "web_search", "message"]);
  assert.ok(!allowed.includes("codex_plugins"));
  assert.ok(allowed.includes("researchdata__*") && allowed.includes("firecrawl__firecrawl_scrape"));
});

test("Tool Search without unlisted entries keeps MCP closed", () => {
  const allowed = resolveAllowedTools(toolSearchBody, known, directoryPrompt(["- web_search (core): x"], 0));
  assert.deepEqual(allowed, ["read", "exec", "web_search"]);
  const none = "Available deferred-schema tools: none.\n";
  assert.deepEqual(resolveAllowedTools(toolSearchBody, known, none), ["read", "exec"]);
});

test("directory is ignored without tool_call or without a directory", () => {
  const system = directoryPrompt(["- web_search (core): x"], 5);
  assert.deepEqual(resolveAllowedTools({ tools: [{ name: "exec" }] }, known, system), ["exec"]);
  assert.deepEqual(resolveAllowedTools(toolSearchBody, known, "no directory here"), ["read", "exec"]);
  assert.equal(readToolSearchDirectory("x"), null);
});

test("non-array tools is a 400", () => {
  assert.throws(() => resolveAllowedTools({ tools: "exec" }, known), /tools must be an array/);
});

test("allowlist env: unrestricted deletes, empty uses sentinel", () => {
  const env = { OPENCLAW_MCP_ENABLED_TOOLS: "stale" };
  applyAllowedToolsEnv(env, null);
  assert.equal("OPENCLAW_MCP_ENABLED_TOOLS" in env, false);
  applyAllowedToolsEnv(env, []);
  assert.equal(env.OPENCLAW_MCP_ENABLED_TOOLS, "__none__");
  applyAllowedToolsEnv(env, ["exec", "read"]);
  assert.equal(env.OPENCLAW_MCP_ENABLED_TOOLS, "exec,read");
});

test("response_format normalization", () => {
  assert.equal(parseResponseFormat({}), null);
  assert.equal(parseResponseFormat({ response_format: { type: "text" } }), null);
  assert.deepEqual(parseResponseFormat({ response_format: { type: "json_object" } }), { type: "object" });
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.deepEqual(
    parseResponseFormat({ response_format: { type: "json_schema", json_schema: { name: "x", schema } } }),
    schema,
  );
  assert.throws(
    () => parseResponseFormat({ response_format: { type: "json_schema", json_schema: {} } }),
    /JSON Schema object/,
  );
  assert.throws(
    () => parseResponseFormat({ response_format: { type: "yaml" } }),
    /Unsupported response_format/,
  );
});
