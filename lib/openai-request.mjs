import fs from "node:fs";

// Shared OpenAI-request translation helpers for the CLI gateways, so every
// lane presents the same provider surface to OpenClaw: per-request tool
// narrowing (tools / tool_choice) and structured output (response_format).
// The Muse gateway keeps its equivalent logic in muse-cli-gateway/request.mjs.

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

// Returns null when the request carries no tool restriction (legacy
// behaviour: the full OpenClaw MCP set), [] for tool_choice "none", or the
// intersected allowlist. Dynamic upstream catalogs are attached by the
// proxy itself, so their prefixed names pass by pattern, not by schema.
export function resolveAllowedTools(body, knownTools) {
  if (body.tool_choice === "none") return [];
  if (body.tools === undefined) return null;
  if (!Array.isArray(body.tools)) throw badRequest("tools must be an array");
  const allowed = [];
  for (const entry of body.tools) {
    let name = entry?.function?.name ?? entry?.name;
    if (typeof name !== "string") continue;
    name = name.replace(/^mcp__openclaw__/, "").replace(/^openclaw__/, "");
    name = name.replace(/^mcp__(gridcraft|wordcraft|pdfcraft|researchdata)__/, "$1__");
    const upstream = /^(guidepoint|alphaengine|gridcraft|wordcraft|pdfcraft|researchdata)__[A-Za-z0-9_]+$/.test(name)
      || name === "firecrawl__firecrawl_scrape";
    if ((knownTools.has(name) || upstream) && !allowed.includes(name)) allowed.push(name);
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
