import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAllowedToolsEnv, parseResponseFormat, readOpenClawToolNames, resolveAllowedTools } from "./openai-request.mjs";
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
