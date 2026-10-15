import fs from "node:fs";

// Shared OpenAI-request translation helpers for the CLI gateways, so every
// lane presents the same provider surface to OpenClaw: per-request tool
// narrowing (tools / tool_choice) and structured output (response_format).
// The Muse gateway shares resolveAllowedTools but keeps its own tool-name set.

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// Tool names the openclaw MCP proxy can serve: the generated gateway-tool
// schema plus the proxy's own local tools (kept in sync with the Muse
// gateway's readToolNames).
export function readOpenClawToolNames(schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const entries = Array.isArray(schema) ? schema : schema.tools;
  if (!Array.isArray(entries)) throw new Error("OpenClaw MCP tool schema has an unsupported shape");
  const localProxyTools = ["sessions_start", "read", "write", "edit", "exec", "glob", "grep", "process"];
  return new Set([...localProxyTools, ...entries.map((x) => x.name).filter((x) => typeof x === "string")]);
}

// Server-prefix wildcards the proxy expands over its bridged MCP catalogs.
export const BRIDGED_MCP_TOOLS = [
  "guidepoint__*", "alphaengine__*", "gridcraft__*", "wordcraft__*", "pdfcraft__*", "researchdata__*",
  "firecrawl__firecrawl_scrape",
];

// OpenClaw Tool Search (on by default while tools.toolSearch is unset) sends
// only its direct tools plus tool_search/tool_describe/tool_call, and lists
// the rest of the policy-filtered catalog in a system-prompt directory. These
// lanes run tools through the MCP proxy, never through OpenClaw's tool_call,
// so the deferred catalog is rebuilt from that directory: listed OpenClaw
// names, plus the bridged MCP catalogs when it reports unlisted entries (MCP
// and client names are never listed). Returns null without a directory.
export function readToolSearchDirectory(systemText) {
  const heading = "Available deferred-schema tools:";
  const start = typeof systemText === "string" ? systemText.indexOf(heading) : -1;
  if (start < 0) return null;
  const lines = systemText.slice(start + heading.length).split("\n");
  if (lines[0].trim() === "none.") return { names: [], omitted: 0 };
  const names = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const row = lines[i].match(/^- ([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})(?: \([^)\n]*\))?(?::|$)/);
    if (!row) break;
    names.push(row[1]);
  }
  let omitted = 0;
  for (const line of lines.slice(i, i + 4)) {
    const match = line.match(/^(\d+) additional tools omitted\./);
    if (match) omitted = Number(match[1]);
  }
  return { names, omitted };
}

// Returns null when the request carries no tool restriction (legacy
// behaviour: the full OpenClaw MCP set), [] for tool_choice "none", or the
// intersected allowlist. Dynamic upstream catalogs are attached by the
// proxy itself, so their prefixed names pass by pattern, not by schema.
export function resolveAllowedTools(body, knownTools, systemText = "") {
  if (body.tool_choice === "none") return [];
  if (body.tools === undefined) return null;
  if (!Array.isArray(body.tools)) throw badRequest("tools must be an array");
  const allowed = [];
  let toolSearch = false;
  for (const entry of body.tools) {
    let name = entry?.function?.name ?? entry?.name;
    if (typeof name !== "string") continue;
    name = name.replace(/^mcp__openclaw__/, "").replace(/^openclaw__/, "");
    name = name.replace(/^mcp__(gridcraft|wordcraft|pdfcraft|researchdata)__/, "$1__");
    if (name === "tool_call") toolSearch = true;
    const upstream = /^(guidepoint|alphaengine|gridcraft|wordcraft|pdfcraft|researchdata)__[A-Za-z0-9_]+$/.test(name)
      || name === "firecrawl__firecrawl_scrape";
    if ((knownTools.has(name) || upstream) && !allowed.includes(name)) allowed.push(name);
  }
  const directory = toolSearch ? readToolSearchDirectory(systemText) : null;
  if (directory) {
    for (const name of directory.names) {
      if (knownTools.has(name) && !allowed.includes(name)) allowed.push(name);
    }
    if (directory.omitted > 0) allowed.push(...BRIDGED_MCP_TOOLS.filter((name) => !allowed.includes(name)));
  }
  return allowed;
}

// The MCP proxy treats an empty OPENCLAW_MCP_ENABLED_TOOLS as unrestricted,
// so an explicitly empty allowlist travels as a sentinel that matches no
// tool. Unrestricted requests delete the variable instead.
export function applyAllowedToolsEnv(env, allowedTools) {
  if (allowedTools === null) delete env.OPENCLAW_MCP_ENABLED_TOOLS;
  else env.OPENCLAW_MCP_ENABLED_TOOLS = allowedTools.length ? allowedTools.join(",") : "__none__";
  return env;
}

// Normalizes OpenAI response_format to a JSON Schema object, or null for
// plain text. Downstream CLIs enforce the schema natively (claude/agy
// --json-schema, muse --output-schema); their structured_output/result is
// what the gateways return, never the free-form prose around it.
export function parseResponseFormat(body) {
  const format = body.response_format;
  if (format === undefined || format === null) return null;
  if (typeof format !== "object" || Array.isArray(format)) {
    throw badRequest("response_format must be an object");
  }
  if (format.type === undefined || format.type === "text") return null;
  if (format.type === "json_object") return { type: "object" };
  if (format.type === "json_schema") {
    const schema = format.json_schema?.schema ?? format.schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw badRequest("response_format.json_schema.schema must be a JSON Schema object");
    }
    return schema;
  }
  throw badRequest(`Unsupported response_format type '${format.type}'`);
}
