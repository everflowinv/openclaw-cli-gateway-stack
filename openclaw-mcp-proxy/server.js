#!/usr/bin/env node
/**
 * OpenClaw MCP Proxy Server
 * Exposes all OpenClaw tools over MCP stdio, proxying calls to /tools/invoke.
 *
 * Usage (add to Claude Code ~/.claude.json):
 *   "mcpServers": {
 *     "openclaw": {
 *       "command": "node",
 *       "args": ["/Users/everflow/Projects/openclaw-cli-gateway-stack/openclaw-mcp-proxy/server.js"]
 *     }
 *   }
 */

const http = require("http");
const fs = require("fs");
const fspath = require("path");
const readline = require("readline");
const { randomUUID } = require("crypto");
const { execFile: nodeExecFile, spawn: nodeSpawn } = require("child_process");
const { createPendingYieldStore } = require("./pending-yield-store");
const { waitForYieldContinuation } = require("./direct-agent-continuation");
const { readSqliteAssistantTexts, selectRunAssistantTexts } = require("./session-reply-store");
const { createCraftBridge } = require("./craft-stdio.cjs");
const { upstreamToolSelected } = require("./upstream-selection.cjs");
const { createRequesterContext } = require("./requester-context.cjs");
const { waitForSpawnedRuns } = require("./spawned-run-wait.cjs");

const OPENCLAW_HOME = process.env.OPENCLAW_HOME
  || fspath.join(require("node:os").homedir(), ".openclaw");
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE
  || fspath.join(OPENCLAW_HOME, "workspace");

function parseCsvEnv(name) {
  return new Set(
    String(process.env[name] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function parsePositiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Optional server-side restrictions for least-privilege remote bridges. These
// are enforced by the proxy itself; client-side MCP enabled_tools is not a
// security boundary because a different MCP client could ignore it.
const CONFIGURED_TOOL_ALLOWLIST = parseCsvEnv("OPENCLAW_MCP_ENABLED_TOOLS");
const CONFIGURED_SESSIONS_SEND_TARGET = String(
  process.env.OPENCLAW_MCP_SESSIONS_SEND_TARGET || ""
).trim();
const DYNAMIC_SESSIONS_ENABLED = process.env.OPENCLAW_MCP_DYNAMIC_SESSIONS === "1";
const GATEWAY_TOOL_TIMEOUT_MS = parsePositiveIntEnv(
  "OPENCLAW_MCP_GATEWAY_TOOL_TIMEOUT_MS",
  240000
);
const LOCAL_TOOL_TIMEOUT_MS = parsePositiveIntEnv(
  "OPENCLAW_MCP_LOCAL_TOOL_TIMEOUT_MS",
  240000
);
const LOCAL_TOOL_MAX_TIMEOUT_MS = parsePositiveIntEnv(
  "OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS",
  1800000
);
const LOCAL_TOOL_KILL_GRACE_MS = parsePositiveIntEnv(
  "OPENCLAW_MCP_LOCAL_TOOL_KILL_GRACE_MS",
  5000
);
const SESSION_START_TIMEOUT_MS = parsePositiveIntEnv(
  "OPENCLAW_MCP_SESSION_START_TIMEOUT_MS",
  30000
);
const DESKTOP_SESSIONS_SEND_MAX_TIMEOUT_SECONDS = 3600;
const DESKTOP_SESSIONS_SEND_CLEANUP_GRACE_MS = 30000;
const DESKTOP_SESSIONS_SEND_HARD_DEADLINE_MS =
  DESKTOP_SESSIONS_SEND_MAX_TIMEOUT_SECONDS * 1000
  + DESKTOP_SESSIONS_SEND_CLEANUP_GRACE_MS;
const OPENCLAW_CLI = process.env.OPENCLAW_CLI
  || (fs.existsSync(fspath.join(OPENCLAW_HOME, "bin", "openclaw"))
    ? fspath.join(OPENCLAW_HOME, "bin", "openclaw") : "openclaw");
const LEGACY_EVE_DESKTOP_SESSION_KEY = "agent:main:codex-desktop-lumos";
const DYNAMIC_SESSION_KEY_RE = /^agent:main:codex-desktop-lumos-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const EVE_DESKTOP_ROOT = fspath.join(OPENCLAW_WORKSPACE, ".eve-desktop");
const SESSION_ALLOWLIST_ROOT = fspath.join(EVE_DESKTOP_ROOT, "session-allowlist");
const PROXY_LOG_ROOT = fspath.join(EVE_DESKTOP_ROOT, "logs");
const PROXY_LOG_FILE = fspath.join(PROXY_LOG_ROOT, "text-proxy.jsonl");
const DYNAMIC_DESKTOP_TOOLS = new Set(["sessions_start", "sessions_send"]);
// Reconstruct non-yield CLI finals from their exact persisted `${runId}:user`
// input. Yielded turns instead require an accepted-child settle-wake anchor and
// a matching terminal receipt for the continuation run; latest text is unsafe.
const AGENT_SESSIONS_ROOT = fspath.join(OPENCLAW_HOME, "agents", "main", "sessions");
const AGENT_SQLITE_FILE = fspath.join(OPENCLAW_HOME, "agents", "main", "agent", "openclaw-agent.sqlite");
const SESSION_INDEX_FILE = fspath.join(AGENT_SESSIONS_ROOT, "sessions.json");
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TRANSCRIPT_REPLY_MAX_CHARS = parsePositiveIntEnv(
  "OPENCLAW_MCP_TRANSCRIPT_REPLY_MAX_CHARS",
  400000
);
const TRANSCRIPT_REPLY_RETRIES = 3;
const TRANSCRIPT_REPLY_RETRY_DELAY_MS = 250;

function writeProxyDiagnostic(event, fields = {}) {
  if (!DYNAMIC_SESSIONS_ENABLED) return;
  try {
    const desktopStat = fs.lstatSync(EVE_DESKTOP_ROOT);
    if (desktopStat.isSymbolicLink() || !desktopStat.isDirectory()) return;
    try {
      fs.mkdirSync(PROXY_LOG_ROOT, { mode: 0o700 });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    const logDirStat = fs.lstatSync(PROXY_LOG_ROOT);
    if (logDirStat.isSymbolicLink() || !logDirStat.isDirectory()) return;
    fs.chmodSync(PROXY_LOG_ROOT, 0o700);
    const fd = fs.openSync(
      PROXY_LOG_FILE,
      fs.constants.O_WRONLY
        | fs.constants.O_APPEND
        | fs.constants.O_CREAT
        | (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...fields,
      }) + "\n", "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    // Diagnostics must never break the restricted stdio protocol.
  }
}

const LOCAL_TOOL_LOG_FILE = fspath.join(OPENCLAW_HOME, "logs", "openclaw-mcp-local-tools.jsonl");

// One JSONL line per local tool invocation (exec/process/...). This is the only
// persistent record of what foreground commands ran and for how long — the
// caller sees nothing while a tool is in flight, so silent multi-minute gaps in
// the claude-cli-gateway log are otherwise unattributable.
function writeLocalToolLog(record) {
  try {
    fs.mkdirSync(fspath.dirname(LOCAL_TOOL_LOG_FILE), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(
      LOCAL_TOOL_LOG_FILE,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
      0o600
    );
    try {
      fs.writeFileSync(fd, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...record }) + "\n", "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    // Auditing must never break tool calls.
  }
}

function localToolLogFields(args) {
  const fields = {};
  if (typeof args?.command === "string") fields.command = args.command.slice(0, 500);
  if (typeof args?.cwd === "string") fields.cwd = args.cwd;
  const timeout = args?.timeoutMs ?? args?.timeout;
  if (timeout !== undefined && timeout !== null) fields.timeoutMs = timeout;
  return fields;
}

function isToolAllowed(name) {
  if (DYNAMIC_SESSIONS_ENABLED && !DYNAMIC_DESKTOP_TOOLS.has(name)) return false;
  if (name === "sessions_start" && !DYNAMIC_SESSIONS_ENABLED) return false;
  return CONFIGURED_TOOL_ALLOWLIST.size === 0 || CONFIGURED_TOOL_ALLOWLIST.has(name);
}

// ── Config ──────────────────────────────────────────────────────────────────

// gateway.auth.token / .password may be either a literal string or a secret
// reference {source:"file"|"env", provider, id}. Older configs used literals;
// once the value moves into secrets.providers, string-concatenating the object
// yields "Bearer [object Object]" and every gateway tool fails with 401.
function resolveSecretRef(cfg, ref) {
  if (ref == null) return "";
  if (typeof ref === "string") return ref;
  if (typeof ref !== "object") return "";

  if (ref.source === "env") {
    return process.env[ref.id || ref.name] || "";
  }
  if (ref.source !== "file") {
    throw new Error("Unsupported secret source: " + ref.source);
  }

  const provider = ((cfg.secrets || {}).providers || {})[ref.provider];
  if (!provider) throw new Error("Unknown secret provider: " + ref.provider);
  const raw = fs.readFileSync(provider.path, "utf8");

  if (provider.mode === "json") {
    // ref.id is a JSON pointer, e.g. "/config/gatewayAuthToken"
    let node = JSON.parse(raw);
    for (const seg of String(ref.id || "").split("/").filter(Boolean)) {
      node = node?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    if (typeof node !== "string") {
      throw new Error("Secret " + ref.provider + ref.id + " is not a string");
    }
    return node;
  }
  return raw.trim();
}

// 2026.8+ multi-agent rosters set `agents.ownership: "explicit"`, and the gateway
// refuses to resolve a session key that does not name an owner — including the
// bare "main" it falls back to when no sessionKey is sent. Resolved once here so
// invokeGatewayTool never re-reads the (tens of KB, frequently rewritten)
// openclaw.json on the request path.
function resolveRequesterAgentId(cfg) {
  const agents = cfg.agents || {};
  const configured = agents.defaults?.systemAgent?.agentId;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const ids = Object.keys(agents.entries || {});
  // A single-agent roster resolves unambiguously on its own; leave it alone.
  return ids.length === 1 ? ids[0] : "main";
}

// Agent-prefixed keys are `agent:<agent-id>:<session-key>` and already name their
// owner. Sending agentId alongside one is rejected when the two disagree
// ("does not match session key agent"), so only supply it for unscoped keys.
function isAgentScopedSessionKey(sessionKey) {
  return typeof sessionKey === "string" && /^agent:[^:]+:.+/.test(sessionKey);
}

function loadGatewayConfig() {
  const cfg = JSON.parse(
    fs.readFileSync(fspath.join(OPENCLAW_HOME, "openclaw.json"), "utf8")
  );
  const gw = cfg.gateway || {};
  const auth = gw.auth || {};
  const token = resolveSecretRef(cfg, auth.token)
    || process.env.OPENCLAW_GATEWAY_TOKEN
    || "";
  const mode = auth.mode || "token";
  const password = resolveSecretRef(cfg, auth.password);
  if (mode === "token" && !token) {
    throw new Error("gateway.auth.mode is 'token' but no token could be resolved");
  }
  const logFile = cfg.logging?.file;
  return {
    port: gw.port || 18789,
    token,
    mode,
    password,
    requesterAgentId: resolveRequesterAgentId(cfg),
    // Only used to read back masked tool errors; see resolveGatewayFailureDetail.
    logFile: typeof logFile === "string" && logFile.trim() ? logFile.trim() : "",
  };
}

let gwConfig;
try {
  gwConfig = loadGatewayConfig();
} catch (e) {
  process.stderr.write("[openclaw-mcp] Failed to load config: " + e.message + "\n");
  process.exit(1);
}

// ── Simulated yield state ─────────────────────────────────────────────────────
// Each run is persisted in its own atomically-renamed file. This avoids the
// lost-update race from a shared read/modify/write JSON array when multiple
// Claude CLI gateway requests spawn subagents concurrently. Reads are scoped to
// the requester session so one conversation never waits on another's children.
const pendingYieldStore = createPendingYieldStore({
  dir: fspath.join(OPENCLAW_WORKSPACE, "temp", "openclaw-mcp-pending-yields"),
  legacyFile: fspath.join(OPENCLAW_WORKSPACE, "temp", ".pending_yield_runids.json"),
});

async function simulatedYield(timeoutMs, callerSessionKey) {
  return JSON.stringify(await waitForSpawnedRuns({
    entries: pendingYieldStore.read(callerSessionKey),
    observe: waitForDirectContinuationRun,
    remove: pendingYieldStore.remove,
    timeoutMs: timeoutMs ?? Math.min(GATEWAY_TOOL_TIMEOUT_MS, 240000),
  }));
}

// ── Tool definitions ─────────────────────────────────────────────────────────

// Local tools (implemented in-process; the gateway HTTP surface denies exec/fs).
const LOCAL_TOOL_DEFS = [
  {
    name: "sessions_start",
    description: "Create a new isolated Eve Desktop session and return its registered session key",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", const: "ok" },
        sessionKey: { type: "string" },
      },
      required: ["status", "sessionKey"],
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description: "Read the contents of a file at the specified path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        encoding: { type: "string", description: "File encoding, defaults to utf-8" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write content to a file, creating directories if needed",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "Edit a file by replacing oldString with newString",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        oldString: { type: "string", description: "The text to replace" },
        newString: { type: "string", description: "The replacement text" },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  {
    name: "exec",
    description: "Execute a foreground bash command and return the output. Commands have a hard timeout. Do not use shell backgrounding (& or nohup); use process(action=start) so long-running children can be polled and stopped.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        cwd: { type: "string", description: "Working directory for the command" },
        timeoutMs: { type: "number", description: "Hard timeout in milliseconds (default " + LOCAL_TOOL_TIMEOUT_MS + ", maximum " + LOCAL_TOOL_MAX_TIMEOUT_MS + "). On timeout the command is killed and its partial output is returned; switch to process(action=start) for longer work." },
        timeout: { type: "number", description: "Deprecated alias for timeoutMs" },
      },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern like **/*.ts" },
        cwd: { type: "string", description: "Base directory for the search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search for a pattern in files",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in" },
        include: { type: "string", description: "File pattern to include, e.g., *.ts" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "process",
    description: "Manage background exec sessions",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action: start, stop, poll, list, kill" },
        command: { type: "string" },
        sessionId: { type: "string" },
        timeout: { type: "number", description: "For start: optional hard runtime limit in ms. For poll: wait up to 30000ms." },
      },
      required: ["action"],
    },
  },
];

// sessions_yield is simulated locally (blocking poll), so it keeps its own schema.
const SESSIONS_YIELD_TOOL =
  {
    name: "sessions_yield",
    description: "Wait for this MCP requester's accepted child runs and return their verified final replies in this tool response. No channel/main-session delivery. Timeout retains pending runs; call again without respawning. Default 240000ms; max 1800000ms.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", description: "Max wait in milliseconds (default 240000; maximum 1800000)" },
        sessionKey: {
          type: "string",
          description:
            "Caller identity is bound by the MCP transport. Omit this field; another key is rejected. Only accepted runs recorded for this caller are observed.",
        },
      },
    },
  };

// Gateway-proxied tools: schemas generated from the gateway itself by
// regen-tools-schema.mjs (run after every OpenClaw upgrade, then restart proxy).
// Declaring the FULL canonical schema matters: the MCP client strips any args
// not present in the declared schema before sending.
const SCHEMA_FILE = fspath.join(__dirname, "tools-schema.json");
let gatewayToolDefs = [];
try {
  const parsed = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
  // Versioned wrapper {openclawVersion, generatedAt, tools} or legacy bare array.
  gatewayToolDefs = Array.isArray(parsed) ? parsed : parsed.tools || [];
  if (!Array.isArray(parsed)) {
    process.stderr.write(
      "[openclaw-mcp] Loaded " + gatewayToolDefs.length + " gateway tool schemas (openclaw " + parsed.openclawVersion + ", generated " + parsed.generatedAt + ")\n"
    );
  }
} catch (e) {
  process.stderr.write("[openclaw-mcp] WARNING: cannot load tools-schema.json (" + e.message + "); gateway tools unavailable. Run regen-tools-schema.mjs.\n");
}
const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOL_DEFS.map((t) => t.name));
const TOOLS = [
  ...LOCAL_TOOL_DEFS,
  SESSIONS_YIELD_TOOL,
  ...gatewayToolDefs.filter((t) => !LOCAL_TOOL_NAMES.has(t.name) && t.name !== "sessions_yield"),
]
  .filter((tool) => isToolAllowed(tool.name))
  .map((tool) => {
    if (!DYNAMIC_SESSIONS_ENABLED || tool.name !== "sessions_send") return tool;
    return {
      ...tool,
      description:
        `Send a message once to a registered Eve Desktop session and wait up to ${DESKTOP_SESSIONS_SEND_MAX_TIMEOUT_SECONDS} seconds, including native subagent yield continuation. A successful reply is returned in this MCP response, not a separate Desktop delivery. On timeout or superseded status do not automatically resend the original message.`,
      inputSchema: {
        type: "object",
        required: ["sessionKey", "message"],
        properties: {
          sessionKey: { type: "string" },
          message: { type: "string" },
          timeoutSeconds: {
            type: "integer",
            minimum: 1,
            maximum: DESKTOP_SESSIONS_SEND_MAX_TIMEOUT_SECONDS,
          },
        },
        additionalProperties: false,
      },
    };
  });

// ── Upstream MCP passthrough ─────────────────────────────────────────────────
// Tools from openclaw.json mcp.servers are attached only to native OpenClaw
// agent runs, NOT to the gateway /tools/invoke surface (resolveGatewayScopedTools
// has no MCP registry), so the gateway path can never serve them. Selected
// streamable-http upstreams are bridged here directly: tools/list is fetched at
// proxy startup, names get the "<server>__" prefix (matching OpenClaw's own
// naming), and calls forward as stateless JSON-RPC POSTs.
// eve-hub (SSE transport, needs stateful session) is intentionally not bridged.
const UPSTREAM_MCP = DYNAMIC_SESSIONS_ENABLED ? [] : [
  { name: "guidepoint", prefix: "guidepoint__", url: "http://127.0.0.1:8943/mcp", timeoutMs: 120000 },
  { name: "alphaengine", prefix: "alphaengine__", url: "http://127.0.0.1:8950/mcp", timeoutMs: 120000 },
  {
    name: "firecrawl",
    prefix: "firecrawl__",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    timeoutMs: 120000,
    allowTools: ["firecrawl_scrape"],
  },
];

function parseMcpHttpBody(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  // SSE framing: take the last "data:" line
  const dataLines = t.split("\n").filter((l) => l.startsWith("data:"));
  if (!dataLines.length) throw new Error("Unrecognized MCP HTTP response: " + t.slice(0, 200));
  return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim());
}

async function upstreamMcpRpc(upstream, method, params, timeoutMs) {
  const res = await fetch(upstream.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(timeoutMs || upstream.timeoutMs || 120000),
  });
  const body = parseMcpHttpBody(await res.text());
  if (body.error) throw new Error(upstream.name + " MCP error: " + (body.error.message || JSON.stringify(body.error)));
  return body.result;
}

const upstreamToolRoutes = new Map(); // prefixed name -> { upstream, bareName }
const craftBridge = createCraftBridge({
  openclawHome: OPENCLAW_HOME,
  disabled: DYNAMIC_SESSIONS_ENABLED,
  allowlist: CONFIGURED_TOOL_ALLOWLIST,
  isToolAllowed,
});
const craftToolsReady = craftBridge.ready.then(() => {
  for (const tool of craftBridge.tools) if (!TOOLS.some(t => t.name === tool.name)) TOOLS.push(tool);
});
const upstreamToolsReady = (async () => {
  const configuredServers = JSON.parse(fs.readFileSync(
    fspath.join(OPENCLAW_HOME, "openclaw.json"), "utf8")).mcp?.servers || {};
  for (const upstream of UPSTREAM_MCP) {
    if (configuredServers[upstream.name]?.enabled === false) continue;
    try {
      const result = await upstreamMcpRpc(upstream, "tools/list", {}, 5000);
      for (const t of result.tools || []) {
        if (Array.isArray(upstream.allowTools) && !upstream.allowTools.includes(t.name)) continue;
        if (!upstreamToolSelected(configuredServers[upstream.name], t.name)) continue;
        const prefixed = upstream.prefix + t.name;
        if (!isToolAllowed(prefixed)) continue;
        if (TOOLS.some((d) => d.name === prefixed)) continue;
        TOOLS.push({
          name: prefixed,
          description: (t.description || t.name).slice(0, 1024),
          inputSchema: t.inputSchema || { type: "object", properties: {}, additionalProperties: true },
        });
        upstreamToolRoutes.set(prefixed, { upstream, bareName: t.name });
      }
      process.stderr.write("[openclaw-mcp] upstream " + upstream.name + ": bridged " + upstreamToolRoutes.size + " tool(s)\n");
    } catch (e) {
      process.stderr.write("[openclaw-mcp] WARNING: upstream " + upstream.name + " unavailable (" + e.message + "); its tools are skipped for this proxy lifetime\n");
    }
  }
})();

async function invokeUpstreamTool(name, args) {
  const { upstream, bareName } = upstreamToolRoutes.get(name);
  const r = await upstreamMcpRpc(upstream, "tools/call", { name: bareName, arguments: args || {} });
  if (r && Array.isArray(r.content)) {
    const text = r.content
      .map((c) => (c && c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
    if (r.isError) throw new Error(text.slice(0, 2000));
    return text;
  }
  return r;
}

// ── Local tool implementations ───────────────────────────────────────────────
// These tools are implemented directly using Node.js built-ins
// instead of proxying to the gateway HTTP endpoint.

const LOCAL_TOOLS = new Set(["sessions_start", "exec", "read", "write", "edit", "glob", "grep", "process"]);

// Background process sessions for `process` tool
const bgSessions = new Map();
let bgSessionCounter = 0;

function resolveLocalToolTimeoutMs(value) {
  if (value === undefined || value === null || value === "") return LOCAL_TOOL_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  return Math.min(Math.trunc(parsed), LOCAL_TOOL_MAX_TIMEOUT_MS);
}

function signalProcessTree(child, signal) {
  if (!child?.pid) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (_) {}
  }
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return child.kill(signal);
  } catch (_) {
    return false;
  }
}

function stopProcessTree(child) {
  const signaled = signalProcessTree(child, "SIGTERM");
  if (!signaled) return null;
  const forceKillTimer = setTimeout(() => {
    signalProcessTree(child, "SIGKILL");
  }, LOCAL_TOOL_KILL_GRACE_MS);
  forceKillTimer.unref?.();
  return forceKillTimer;
}

// child_process.exec() drops `detached`'s new-process-group semantics on this
// node/macOS setup (the shell stays in our process group), so a timeout kill
// could only reach the shell itself: grandchildren kept the stdio pipes open,
// the exec callback never fired, and the MCP tool call hung forever. Spawning
// /bin/sh directly with detached:true reliably makes it a group leader, which
// keeps kill(-pgid) in signalProcessTree effective for the whole tree.
function execGrouped(command, options, callback) {
  const child = nodeSpawn("/bin/sh", ["-c", command], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cap = options.maxBuffer || 10 * 1024 * 1024;
  let stdout = "";
  let stderr = "";
  let overflowed = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > cap && !overflowed) {
      overflowed = true;
      stopProcessTree(child);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > cap && !overflowed) {
      overflowed = true;
      stopProcessTree(child);
    }
  });
  child.on("error", (err) => callback(err, stdout, stderr));
  child.on("close", (code, signal) => {
    if (overflowed) {
      const error = new Error("maxBuffer size exceeded");
      error.killed = true;
      return callback(error, stdout.slice(0, cap), stderr.slice(0, cap));
    }
    let err = null;
    if (signal) {
      err = new Error(`Command failed: ${command}`);
      err.killed = true;
      err.signal = signal;
    } else if (code !== 0) {
      err = new Error(`Command failed: ${command}`);
      err.code = code;
    }
    return callback(err, stdout, stderr);
  });
  return child;
}

function runCapturedChild(startChild, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let child;
    let timedOut = false;
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      forceKillTimer = stopProcessTree(child);
    }, timeoutMs);
    timer.unref?.();

    const finish = (err, stdout, stderr) => {
      clearTimeout(timer);
      if (timedOut) {
        // Return the output collected before the kill so the model can judge
        // progress and decide whether to retry, lower scope, or go background.
        const partial = [stdout, stderr].filter(Boolean).join("\n[stderr]\n").trim();
        const error = new Error(
          `${label} timed out after ${timeoutMs}ms`
            + (partial ? `. Partial output (tail):\n${partial.slice(-2000)}` : " with no output")
        );
        error.code = "LOCAL_TOOL_TIMEOUT";
        return reject(error);
      }
      if (forceKillTimer) clearTimeout(forceKillTimer);
      return resolve({ err, stdout: stdout || "", stderr: stderr || "" });
    };

    try {
      child = startChild(finish);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function appendBackgroundOutput(proc, chunk) {
  const MAX_BACKGROUND_OUTPUT_BYTES = 10 * 1024 * 1024;
  proc.output += chunk.toString("utf8");
  if (Buffer.byteLength(proc.output, "utf8") > MAX_BACKGROUND_OUTPUT_BYTES) {
    proc.output = proc.output.slice(-MAX_BACKGROUND_OUTPUT_BYTES);
    proc.outputTruncated = true;
  }
}

async function invokeLocalTool(name, args) {
  switch (name) {
    case "sessions_start":
      return createDynamicSession(args);

    case "read": {
      const { path: filePath, encoding = "utf8" } = args;
      if (!filePath) throw new Error("path is required");
      return fs.readFileSync(filePath, encoding);
    }

    case "write": {
      const { path: filePath, content } = args;
      if (!filePath) throw new Error("path is required");
      const dir = fspath.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content != null ? content : "", "utf8");
      return "Written to " + filePath;
    }

    case "edit": {
      const { path: filePath, oldString, newString } = args;
      if (!filePath || oldString === undefined || newString === undefined)
        throw new Error("path, oldString, and newString are required");
      const original = fs.readFileSync(filePath, "utf8");
      if (!original.includes(oldString))
        throw new Error("oldString not found in " + filePath);
      // Use split/join to avoid special replacement pattern interpretation
      const parts = original.split(oldString);
      const updated = parts[0] + newString + parts.slice(1).join(oldString);
      fs.writeFileSync(filePath, updated, "utf8");
      return "Edited " + filePath;
    }

    case "exec": {
      const { command, cwd, timeoutMs, timeout } = args;
      if (!command) throw new Error("command is required");
      const hardTimeoutMs = resolveLocalToolTimeoutMs(timeoutMs ?? timeout);
      const { err, stdout, stderr } = await runCapturedChild(
        (callback) => execGrouped(command, {
          cwd: cwd || process.cwd(),
          maxBuffer: 10 * 1024 * 1024,
        }, callback),
        hardTimeoutMs,
        "Command"
      );
      let out = stdout + (stderr ? "\n[stderr]\n" + stderr : "");
      if (err && !stdout) throw new Error(stderr || err.message);
      if (err) out += "\n[exit code " + (typeof err.code === "number" ? err.code : 1) + "]";
      return out.trim();
    }

    case "glob": {
      const { pattern, cwd: baseCwd } = args;
      if (!pattern) throw new Error("pattern is required");
      const base = baseCwd || process.cwd();
      return new Promise((resolve, reject) => {
        // Exclude common large dirs to avoid maxBuffer overflow
        const findCmd = "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/__pycache__/*' | sort";
        runCapturedChild(
          (callback) => execGrouped(findCmd, {
            cwd: base,
            maxBuffer: 10 * 1024 * 1024,
          }, callback),
          LOCAL_TOOL_TIMEOUT_MS,
          "Glob"
        ).then(({ err, stdout }) => {
          if (err) return reject(err);
          const lines = stdout.trim().split("\n").filter(Boolean).map(function(l) {
            return l.replace(/^\.\//, "");
          });
          // Convert glob pattern to regex
          var regexStr = "";
          var i = 0;
          while (i < pattern.length) {
            if (pattern[i] === "*" && pattern[i + 1] === "*") {
              regexStr += ".*";
              i += 2;
              if (pattern[i] === "/") i++;
            } else if (pattern[i] === "*") {
              regexStr += "[^/]*";
              i++;
            } else if (pattern[i] === "?") {
              regexStr += "[^/]";
              i++;
            } else if (".+^${}()|[]\\".indexOf(pattern[i]) >= 0) {
              regexStr += "\\" + pattern[i];
              i++;
            } else {
              regexStr += pattern[i];
              i++;
            }
          }
          var regex = new RegExp("^" + regexStr + "$");
          var matches = lines.filter(function(l) { return regex.test(l); });
          resolve(matches.join("\n"));
        }, reject);
      });
    }

    case "grep": {
      const { pattern, path: searchPath, include } = args;
      if (!pattern) throw new Error("pattern is required");
      const target = searchPath || process.cwd();
      // execFile: no shell involved, so regex metacharacters ($, backticks, quotes)
      // in the pattern reach grep verbatim instead of being shell-expanded.
      const grepArgs = ["-rn", "-E"];
      if (include) grepArgs.push("--include=" + include);
      grepArgs.push("--", pattern, target);
      const { stdout } = await runCapturedChild(
        (callback) => nodeExecFile("grep", grepArgs, {
          detached: process.platform !== "win32",
          maxBuffer: 5 * 1024 * 1024,
        }, callback),
        LOCAL_TOOL_TIMEOUT_MS,
        "Grep"
      );
      // grep exits with 1 when no matches — not an error
      const lines = stdout.split("\n").filter(Boolean).slice(0, 500);
      return lines.join("\n") || "(no matches)";
    }

    case "process": {
      const { action, command, sessionId, timeout } = args;
      if (action === "start") {
        if (!command) throw new Error("command is required for start");
        const runtimeMs = timeout === undefined || timeout === null
          ? null
          : resolveLocalToolTimeoutMs(timeout);
        const sid = "bg-" + (++bgSessionCounter);
        const proc = { output: "", outputTruncated: false, done: false, exitCode: null, startedAt: Date.now(), child: null, runtimeTimer: null };
        bgSessions.set(sid, proc);
        const child = execGrouped(command, {
          maxBuffer: 10 * 1024 * 1024,
        }, (err) => {
          if (proc.runtimeTimer) clearTimeout(proc.runtimeTimer);
          proc.done = true;
          proc.exitCode = err ? (err.code || 1) : 0;
        });
        proc.child = child;
        if (child.stdout) child.stdout.on("data", function(d) { appendBackgroundOutput(proc, d); });
        if (child.stderr) child.stderr.on("data", function(d) { appendBackgroundOutput(proc, d); });
        if (runtimeMs !== null) {
          proc.runtimeTimer = setTimeout(() => {
            stopProcessTree(child);
          }, runtimeMs);
          proc.runtimeTimer.unref?.();
        }
        return JSON.stringify({ sessionId: sid, status: "started" });
      }
      if (action === "poll") {
        const s = bgSessions.get(sessionId);
        if (!s) throw new Error("Session " + sessionId + " not found");
        const waitMs = timeout || 0;
        if (!s.done && waitMs > 0) {
          await new Promise(function(r) { setTimeout(r, Math.min(waitMs, 30000)); });
        }
        return JSON.stringify({ sessionId, done: s.done, exitCode: s.exitCode, output: s.output, outputTruncated: s.outputTruncated });
      }
      if (action === "list") {
        const list = [];
        for (const [id, s] of bgSessions) list.push({ sessionId: id, done: s.done, exitCode: s.exitCode, outputTruncated: s.outputTruncated });
        return JSON.stringify(list);
      }
      if (action === "kill" || action === "stop") {
        const s = bgSessions.get(sessionId);
        if (!s) throw new Error("Session " + sessionId + " not found");
        if (s.runtimeTimer) clearTimeout(s.runtimeTimer);
        const signaled = Boolean(stopProcessTree(s.child));
        bgSessions.delete(sessionId);
        return JSON.stringify({ sessionId, status: signaled ? "stopping" : "removed" });
      }
      throw new Error("Unknown process action: " + action);
    }

    default:
      throw new Error("No local implementation for " + name);
  }
}

// ── HTTP invoke ──────────────────────────────────────────────────────────────

// Tools where args.sessionKey means "who is asking" (hoisted to body top level),
// not a target session argument.
const SESSION_IDENTITY_TOOLS = new Set(["sessions_spawn", "subagents"]);

function normalizeOptionalSessionKey(v) {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s !== "main" ? s : undefined;
}

// Caller identity is owned by the gateway transport, not model-supplied args.
const requesterContext = createRequesterContext({
  sessionKey: process.env.OPENCLAW_REQUESTER_SESSION_KEY,
  agentId: gwConfig.requesterAgentId,
});
const DEFAULT_REQUESTER_SESSION_KEY = requesterContext.sessionKey;

function normalizeToolArgs(toolName, args) {
  const input = args || {};

  if (toolName === "sessions_send" && DYNAMIC_SESSIONS_ENABLED) {
    validateRestrictedSessionsSend(input);
    const normalized = {
      sessionKey: input.sessionKey,
      message: input.message,
    };
    if (input.timeoutSeconds !== undefined) {
      normalized.timeoutSeconds = input.timeoutSeconds;
    }
    return normalized;
  }

  if (toolName === "sessions_send" && CONFIGURED_SESSIONS_SEND_TARGET) {
    if (input.sessionKey !== CONFIGURED_SESSIONS_SEND_TARGET || input.agentId !== undefined || input.label !== undefined) {
      throw new Error(
        "sessions_send is restricted to sessionKey " + CONFIGURED_SESSIONS_SEND_TARGET
      );
    }
  }

  if (toolName === "image") {
    // 旧版上游只认 image / images，不认 path
    if (typeof input.path === "string" && !input.image) {
      const { path, ...rest } = input;
      return { ...rest, image: path };
    }
  }

  if (toolName === "pdf") {
    // 上游 pdf tool 只认 pdf / pdfs，不认 path / paths
    const { path, paths, ...rest } = input;
    if (typeof path === "string" && !rest.pdf) rest.pdf = path;
    if (Array.isArray(paths) && !rest.pdfs) rest.pdfs = paths;
    if (path !== undefined || paths !== undefined) return rest;
  }

  // `limit` / `member_type` below are proxy-only back-compat aliases declared by
  // regen-tools-schema.mjs; the gateway itself does not accept them. Always drop
  // the alias, even when the canonical key is also present, so a client that
  // sends both cannot leak an unknown argument through to the gateway.
  if (toolName === "web_search" && input.limit !== undefined) {
    // canonical param is count; limit kept as legacy alias
    const { limit, ...rest } = input;
    if (rest.count === undefined) rest.count = limit;
    return rest;
  }

  if (toolName === "memory_search" && input.limit !== undefined) {
    // canonical param is maxResults; limit kept as legacy alias
    const { limit, ...rest } = input;
    if (rest.maxResults === undefined) rest.maxResults = limit;
    return rest;
  }

  if (toolName === "feishu_chat" && input.member_type !== undefined) {
    // canonical param is member_id_type; member_type kept as legacy alias
    const { member_type, ...rest } = input;
    if (rest.member_id_type === undefined) rest.member_id_type = member_type;
    return rest;
  }

  return input;
}

function assertPrivateDirectory(dirPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(dirPath);
  } catch (err) {
    throw new Error(label + " is unavailable: " + err.message);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(label + " must be a real directory, not a symbolic link");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(label + " must have permissions 0700");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(label + " must be owned by the proxy user");
  }
}

function assertSessionAllowlistDirectories() {
  assertPrivateDirectory(EVE_DESKTOP_ROOT, ".eve-desktop");
  assertPrivateDirectory(SESSION_ALLOWLIST_ROOT, "session allowlist directory");
}

function registrationPathForUuid(uuid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error("Invalid server-generated UUID v4");
  }
  return fspath.join(SESSION_ALLOWLIST_ROOT, uuid);
}

function assertRegisteredDynamicSession(sessionKey) {
  const match = DYNAMIC_SESSION_KEY_RE.exec(sessionKey);
  if (!match) {
    throw new Error("sessions_send sessionKey is not an Eve Desktop dynamic session key");
  }

  assertSessionAllowlistDirectories();
  const registrationPath = registrationPathForUuid(match[1]);
  let fd;
  try {
    fd = fs.openSync(
      registrationPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error("sessions_send sessionKey is not registered");
    }
    throw new Error("Could not validate the session registration: " + err.message);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("Session registration must be a regular file, not a symbolic link");
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error("Session registration must have permissions 0600");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Session registration must be owned by the proxy user");
    }
    if (fs.readFileSync(fd, "utf8") !== sessionKey + "\n") {
      throw new Error("Session registration content does not match sessionKey");
    }
  } finally {
    fs.closeSync(fd);
  }
}

function validateRestrictedSessionsSend(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("sessions_send arguments must be an object");
  }
  const allowedFields = new Set(["sessionKey", "message", "timeoutSeconds"]);
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) {
      throw new Error("sessions_send does not allow argument: " + key);
    }
  }
  if (typeof input.sessionKey !== "string") {
    throw new Error("sessions_send requires sessionKey");
  }
  if (typeof input.message !== "string") {
    throw new Error("sessions_send requires message");
  }
  if (
    input.timeoutSeconds !== undefined &&
    (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0)
  ) {
    throw new Error("sessions_send timeoutSeconds must be a positive integer");
  }
  if (input.sessionKey === LEGACY_EVE_DESKTOP_SESSION_KEY) return;
  assertRegisteredDynamicSession(input.sessionKey);
}

// sessions.json is tens of megabytes; a targeted match avoids parsing the whole
// index on every send, and JSON.parse stays as the fallback if the layout moves.
function resolveSessionTranscriptPath(sessionKey) {
  let raw;
  try {
    raw = fs.readFileSync(SESSION_INDEX_FILE, "utf8");
  } catch (_) {
    return null;
  }
  let sessionId = null;
  const escapedKey = sessionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    '"' + escapedKey + '"\\s*:\\s*\\{\\s*"sessionId"\\s*:\\s*"([^"]+)"'
  ).exec(raw);
  if (match) {
    sessionId = match[1];
  } else {
    try {
      const parsed = JSON.parse(raw);
      const entry = parsed?.[sessionKey] || parsed?.sessions?.[sessionKey];
      if (typeof entry?.sessionId === "string") sessionId = entry.sessionId;
    } catch (_) {
      return null;
    }
  }
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const transcriptPath = fspath.join(AGENT_SESSIONS_ROOT, sessionId + ".jsonl");
  try {
    const stat = fs.lstatSync(transcriptPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
  } catch (_) {
    return null;
  }
  return transcriptPath;
}

function readAssistantTextsForRun(transcriptPath, runId, payloadReply) {
  try {
    const entries = fs.readFileSync(transcriptPath, "utf8").split("\n")
      .filter((line) => line.trim()).map((line) => JSON.parse(line));
    return selectRunAssistantTexts(entries, runId, payloadReply);
  } catch (_) {
    return null;
  }
}

// Keeps the head of the run (the real answer) and always keeps the tail block
// the CLI reported, so an over-long run degrades instead of losing the answer.
function capReplyText(blocks) {
  const joined = blocks.join("\n\n");
  if (joined.length <= TRANSCRIPT_REPLY_MAX_CHARS) return joined;
  const tail = blocks[blocks.length - 1];
  const notice = "\n\n（中间内容过长，已省略。完整记录见会话 transcript。）\n\n";
  const headBudget = Math.max(
    0,
    TRANSCRIPT_REPLY_MAX_CHARS - notice.length - tail.length
  );
  const head = [];
  let used = 0;
  for (const block of blocks.slice(0, -1)) {
    if (used + block.length + 2 > headBudget) break;
    head.push(block);
    used += block.length + 2;
  }
  return head.join("\n\n") + notice + tail;
}

// Empty/yielded replies never enter reconstruction. SQLite takes precedence
// even when its index is unavailable; the legacy JSON fallback is pre-SQLite only.
function rebuildReplyFromTranscript(sessionKey, runId, payloadReply) {
  let texts;
  if (fs.existsSync(AGENT_SQLITE_FILE)) {
    texts = readSqliteAssistantTexts(AGENT_SQLITE_FILE, sessionKey, runId, payloadReply);
  } else {
    const transcriptPath = resolveSessionTranscriptPath(sessionKey);
    if (!transcriptPath) return null;
    texts = readAssistantTextsForRun(transcriptPath, runId, payloadReply);
  }
  if (!texts?.length) return null;
  return { text: capReplyText(texts), blocks: texts.length };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveDirectAgentReply(sessionKey, runId, payloadReply, deadlineAt) {
  for (let attempt = 0; attempt < TRANSCRIPT_REPLY_RETRIES; attempt += 1) {
    if (Date.now() >= deadlineAt) break;
    const rebuilt = rebuildReplyFromTranscript(sessionKey, runId, payloadReply);
    if (Date.now() >= deadlineAt) break;
    if (rebuilt) return { reply: rebuilt.text, source: "transcript", blocks: rebuilt.blocks };
    if (attempt < TRANSCRIPT_REPLY_RETRIES - 1) {
      await delay(Math.min(TRANSCRIPT_REPLY_RETRY_DELAY_MS, Math.max(0, deadlineAt - Date.now())));
    }
  }
  return { reply: payloadReply, source: "payloads", blocks: 0 };
}

// Read-only, host-internal RPC. Desktop still exposes only start/send; the
// candidate id comes from a verified persisted settle-wake input, never caller args.
function waitForDirectContinuationRun(runId, timeoutMs, deadlineAt, signal) {
  const remaining = Math.min(Math.max(1, deadlineAt - Date.now()), timeoutMs + 5000);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Continuation observation cancelled"));
    let observer;
    // execFile's AbortSignal path can use SIGTERM independently of its timeout
    // killSignal. Explicitly reap our read-only observer at the caller deadline.
    const abort = () => observer?.kill("SIGKILL");
    observer = nodeExecFile(OPENCLAW_CLI, [
      "gateway", "call", "agent.wait", "--params", JSON.stringify({ runId, timeoutMs }),
      "--json", "--timeout", String(remaining),
    ], { maxBuffer: 1024 * 1024, timeout: remaining, killSignal: "SIGKILL" }, (err, stdout) => {
      signal?.removeEventListener("abort", abort);
      if (err && !signal?.aborted && (err.killed || err.code === "ETIMEDOUT")) {
        // A read-only observer timing out is not a terminal parent failure.
        return resolve({ runId, status: "timeout" });
      }
      if (err) return reject(new Error("Continuation observation unavailable"));
      try { resolve(JSON.parse(String(stdout || "").trim())); }
      catch (_) { reject(new Error("Invalid continuation observation")); }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function invokeDirectAgent(args) {
  const normalized = normalizeToolArgs("sessions_send", args);
  const timeoutSeconds = normalized.timeoutSeconds === undefined ? 600 : normalized.timeoutSeconds;
  if (timeoutSeconds > DESKTOP_SESSIONS_SEND_MAX_TIMEOUT_SECONDS) {
    throw new Error("sessions_send timeoutSeconds exceeds the proxy deadline");
  }
  const uuidMatch = DYNAMIC_SESSION_KEY_RE.exec(normalized.sessionKey);
  const sessionRef = uuidMatch ? uuidMatch[1] : "legacy";
  const requestId = randomUUID();
  const cliArgs = [
    "agent", "--agent", "main", "--session-key", normalized.sessionKey,
    "--message", normalized.message, "--timeout", String(timeoutSeconds), "--json",
  ];
  const startedAt = Date.now();
  const budgetMs = Math.min(DESKTOP_SESSIONS_SEND_HARD_DEADLINE_MS,
    timeoutSeconds * 1000 + DESKTOP_SESSIONS_SEND_CLEANUP_GRACE_MS);
  const deadlineAt = startedAt + budgetMs;
  writeProxyDiagnostic("sessions_send_start", { sessionRef, requestId, timeoutSeconds });
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let runId = null;
    let continuationRunId = null;
    let yielded = false;
    const observation = new AbortController();
    let sentBeforeError = false;
    let deadlineTimer;
    const finish = (status, fields = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      observation.abort();
      const result = {
        status, requestId, runId, continuationRunId, sessionKey: normalized.sessionKey,
        sentBeforeError: status === "ok" ? false : sentBeforeError,
        ...fields,
        // Returned means the reply is in this MCP response, not that a channel
        // or Desktop has acknowledged it. CLI is invoked without --deliver.
        delivery: { status: status === "ok" ? "returned" : "not_sent", mode: "mcp", externalDelivery: "unverified" },
      };
      writeProxyDiagnostic(status === "ok" ? "sessions_send_ok" : "sessions_send_" + status, {
        sessionRef, requestId, runId, continuationRunId, elapsedMs: Date.now() - startedAt,
        code: fields.code, replySource: fields.replySource,
        replyBlocks: fields.replyBlocks, replyChars: fields.reply?.length ?? 0,
        sentBeforeError: result.sentBeforeError,
      });
      resolve(result);
    };
    const timeout = () => {
      // execFile's timeout alone can wait indefinitely for a SIGTERM-resistant
      // child. This independent deadline also covers async reconstruction.
      if (!yielded) child?.kill("SIGKILL");
      finish("timeout", {
        code: yielded ? "DIRECT_AGENT_CONTINUATION_TIMEOUT" : "DIRECT_AGENT_TIMEOUT",
        execution: yielded ? "waiting_for_completion" : "unknown",
        error: "sessions_send timed out; no final reply is confirmed. The message may still be executing and must not be resent automatically",
      });
    };
    deadlineTimer = setTimeout(timeout, budgetMs);
    child = nodeExecFile(OPENCLAW_CLI, cliArgs, {
      maxBuffer: 10 * 1024 * 1024, timeout: budgetMs,
    }, async (err, stdout) => {
      if (settled) return;
      let parsed;
      try { parsed = JSON.parse(String(stdout || "").trim()); } catch (_) {}
      if (typeof parsed?.runId === "string" && parsed.runId.length <= 2048) runId = parsed.runId;
      if (Date.now() >= deadlineAt || err && (err.killed || err.code === "ETIMEDOUT")) return timeout();
      if (err || parsed?.status !== "ok") {
        if (err?.code === "ENOENT" || err?.code === "EACCES") sentBeforeError = false;
        // Do not echo arbitrary CLI stderr/meta (may contain private yield context).
        return finish("error", {
          code: "DIRECT_AGENT_FAILED", execution: "unknown",
          error: "Direct agent call failed; do not resend automatically. Check the proxy diagnostic using requestId.",
        });
      }
      if (parsed.result?.meta?.yielded === true || parsed.yielded === true) {
        yielded = true;
        writeProxyDiagnostic("sessions_send_yielded", { sessionRef, requestId, runId });
        let continuation;
        try {
          continuation = await waitForYieldContinuation({
            databasePath: AGENT_SQLITE_FILE, sessionKey: normalized.sessionKey, runId,
            deadlineAt, signal: observation.signal, maxReplyChars: TRANSCRIPT_REPLY_MAX_CHARS,
            waitForRun: (id, waitMs, signal) => {
              continuationRunId = id;
              return waitForDirectContinuationRun(id, waitMs, deadlineAt, signal);
            },
          });
        } catch (_) {
          continuation = { status: "yielded", execution: "yielded", retryable: false,
            code: "DIRECT_AGENT_CONTINUATION_UNOBSERVABLE",
            error: "Continuation evidence is unavailable. Do not resend the original message automatically." };
        }
        if (Date.now() >= deadlineAt) return timeout();
        const { status, ...fields } = continuation;
        return finish(status, fields);
      }
      if (parsed.result?.meta?.aborted === true || parsed.result?.meta?.timedOut === true) {
        return finish(parsed.result.meta.timedOut === true ? "timeout" : "error", {
          code: "DIRECT_AGENT_INTERRUPTED", execution: "interrupted",
          error: "The agent run was interrupted; earlier text is not a completed reply. Do not resend automatically.",
        });
      }
      const payloads = Array.isArray(parsed.result?.payloads) ? parsed.result.payloads : [];
      const payloadReply = payloads.map((payload) => typeof payload?.text === "string" ? payload.text : "")
        .filter((text) => text.trim() && !["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP", "REPLY_SKIP"].includes(text.trim())).join("\n\n");
      if (!payloadReply.trim() || ["empty", "silent"].includes(parsed.result?.meta?.terminalReply?.disposition)) {
        return finish("empty", {
          code: "DIRECT_AGENT_EMPTY_FINAL", execution: "completed",
          error: "The run ended without a visible text reply; external delivery is unverified. Do not resend automatically.",
        });
      }
      let reply = { reply: payloadReply, source: "payloads", blocks: 0 };
      try {
        reply = await resolveDirectAgentReply(normalized.sessionKey, runId, payloadReply, deadlineAt);
      } catch (_) { /* The CLI's own nonempty final remains authoritative. */ }
      if (Date.now() >= deadlineAt) return timeout();
      finish("ok", {
        execution: "completed", reply: reply.reply,
        replySource: reply.source, replyBlocks: reply.blocks,
      });
    });
    sentBeforeError = Boolean(child?.pid);
  });
}

function invokeGatewayRpc(method, params) {
  return new Promise((resolve, reject) => {
    const cliArgs = [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      String(SESSION_START_TIMEOUT_MS),
    ];
    nodeExecFile(
      OPENCLAW_CLI,
      cliArgs,
      { maxBuffer: 1024 * 1024, timeout: SESSION_START_TIMEOUT_MS + 5000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || "unknown error").trim();
          return reject(new Error("Gateway RPC " + method + " failed: " + detail.slice(0, 1000)));
        }
        let parsed;
        try {
          parsed = JSON.parse(String(stdout || "").trim());
        } catch (parseError) {
          return reject(new Error("Gateway RPC " + method + " returned invalid JSON"));
        }
        if (parsed?.ok === false || parsed?.error) {
          const message = parsed?.error?.message || parsed?.error || "unknown Gateway error";
          return reject(new Error("Gateway RPC " + method + " failed: " + message));
        }
        resolve(parsed);
      }
    );
  });
}

function writeSessionRegistration(uuid, sessionKey) {
  assertSessionAllowlistDirectories();
  const registrationPath = registrationPathForUuid(uuid);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(registrationPath, flags, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, sessionKey + "\n", "utf8");
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
      fd = undefined;
      try { fs.unlinkSync(registrationPath); } catch (_) {}
    }
    throw new Error("Could not persist the session registration: " + err.message);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  assertRegisteredDynamicSession(sessionKey);
}

async function createDynamicSession(args) {
  if (!DYNAMIC_SESSIONS_ENABLED) {
    throw new Error("sessions_start is disabled");
  }
  if (args !== undefined && (typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0)) {
    throw new Error("sessions_start does not accept arguments");
  }
  assertSessionAllowlistDirectories();
  const uuid = randomUUID().toLowerCase();
  const sessionKey = LEGACY_EVE_DESKTOP_SESSION_KEY + "-" + uuid;
  if (!DYNAMIC_SESSION_KEY_RE.test(sessionKey)) {
    throw new Error("Server-generated session key failed UUID v4 validation");
  }

  const created = await invokeGatewayRpc("sessions.create", {
    key: sessionKey,
    agentId: "main",
  });
  if (created?.ok !== true || created?.key !== sessionKey) {
    throw new Error("Gateway did not confirm the requested session key");
  }
  writeSessionRegistration(uuid, sessionKey);
  writeProxyDiagnostic("sessions_start_ok", { sessionRef: uuid });
  return { status: "ok", sessionKey };
}

// ── Masked gateway error read-back ───────────────────────────────────────────
// Since 2026.8.x the gateway's tools-invoke-shared answers every non-input tool
// error with HTTP 500 {"error":{"type":"tool_error","message":"tool execution
// failed"}} and writes the real cause only to its own log, as a WARN line from
// the "tools-invoke" subsystem ("tool execution failed: Error: <cause>"). That
// leaves MCP clients with no way to tell "trusted operational run instance
// required" apart from a genuine crash. When the masked message comes back, read
// the newest matching log line written since the request started and append it.
// Best effort only: no log, no permission, or no matching line leaves the
// original message intact with a note saying the read-back found nothing.
const GATEWAY_MASKED_ERROR_MESSAGE = "tool execution failed";
const GATEWAY_LOG_FILE_OVERRIDE = (process.env.OPENCLAW_GATEWAY_LOG_FILE || "").trim();
const GATEWAY_LOG_DEFAULT_DIR = "/tmp/openclaw";
const GATEWAY_LOG_TAIL_BYTES = 512 * 1024;
// The gateway logs the cause before it writes the HTTP response, but the file
// append can still land a few ms after the socket closes. Two short retries.
const GATEWAY_LOG_DETAIL_ATTEMPTS = 3;
const GATEWAY_LOG_DETAIL_RETRY_MS = 60;
// Log timestamps and Date.now() share the host clock and the gateway can only
// log the cause after our request reached it, so a line stamped before the
// request started belongs to an earlier call. No slack: with back-to-back calls
// a skew allowance would attribute the previous call's cause to this one.
const GATEWAY_LOG_DETAIL_SKEW_MS = 0;

function formatGatewayLogDate(date) {
  // Same rule as the gateway's rolling log name: the host-local calendar date.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function resolveGatewayLogCandidates(now) {
  if (GATEWAY_LOG_FILE_OVERRIDE) return [GATEWAY_LOG_FILE_OVERRIDE];
  if (gwConfig.logFile) return [gwConfig.logFile];
  // Rolling default: openclaw[-<profile>]-YYYY-MM-DD.log. The profile segment
  // is only appended for a non-default OPENCLAW_PROFILE; unusual profile names
  // the gateway would hash are skipped rather than guessed.
  const profile = (process.env.OPENCLAW_PROFILE || "").trim();
  let suffix = "";
  if (profile && profile.toLowerCase() !== "default") {
    if (!/^[a-z0-9-]+$/i.test(profile)) return [];
    suffix = "-" + profile.toLowerCase();
  }
  const today = new Date(now);
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  return [today, yesterday].map((date) =>
    fspath.join(GATEWAY_LOG_DEFAULT_DIR, `openclaw${suffix}-${formatGatewayLogDate(date)}.log`)
  );
}

function readGatewayLogTailLines(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return [];
    const length = Math.min(stat.size, GATEWAY_LOG_TAIL_BYTES);
    const position = stat.size - length;
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, buffer, 0, length, position);
    const lines = buffer.toString("utf8", 0, read).split("\n");
    // A non-zero offset almost always lands mid-line; drop that fragment.
    if (position > 0) lines.shift();
    return lines;
  } catch (_) {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function extractGatewayFailureDetail(lines, sinceMs) {
  const cutoff = sinceMs - GATEWAY_LOG_DETAIL_SKEW_MS;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("tools-invoke") || !line.includes(GATEWAY_MASKED_ERROR_MESSAGE)) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const stampedAt = Date.parse(entry?._meta?.date || "");
    // Lines are appended in time order, so anything older than the request is
    // from an earlier call and everything before it is older still.
    if (Number.isFinite(stampedAt) && stampedAt < cutoff) return "";
    const subsystem = String(entry?.["0"] || "");
    const message = String(entry?.["1"] || "");
    if (!subsystem.includes("tools-invoke")) continue;
    if (!message.startsWith(GATEWAY_MASKED_ERROR_MESSAGE)) continue;
    const detail = message
      .slice(GATEWAY_MASKED_ERROR_MESSAGE.length)
      .replace(/^[\s:]+/, "")
      .replace(/^Error:\s*/, "")
      .trim();
    if (detail) return detail;
  }
  return "";
}

async function resolveGatewayFailureDetail(sinceMs) {
  for (let attempt = 0; attempt < GATEWAY_LOG_DETAIL_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(GATEWAY_LOG_DETAIL_RETRY_MS);
    for (const file of resolveGatewayLogCandidates(Date.now())) {
      const detail = extractGatewayFailureDetail(readGatewayLogTailLines(file), sinceMs);
      if (detail) return detail;
    }
  }
  return "";
}

async function describeGatewayToolFailure(message, toolName, statusCode, startedAt) {
  if (message !== GATEWAY_MASKED_ERROR_MESSAGE) return message;
  const detail = await resolveGatewayFailureDetail(startedAt);
  if (detail) return `${message} (gateway: ${detail})`;
  return `${message} (HTTP ${statusCode} from gateway for ${toolName}; no matching tools-invoke line found in the gateway log)`;
}

function invokeGatewayTool(toolName, args, sessionKey) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // sessionKey at body top level identifies the requester session to the gateway
    // (tools-invoke-shared resolveSessionKey). Without it the gateway falls back to
    // agent:main:main, which breaks subagent announce routing (spawnedBy mis-recorded).
    const payload = { tool: toolName, args: args || {}, idempotencyKey: randomUUID() };
    if (sessionKey) payload.sessionKey = sessionKey;
    // 2026.8+ requires a named owner when the requester key is unscoped.
    // Agent-prefixed keys retain their own owner (including non-main agents).
    if (!isAgentScopedSessionKey(sessionKey) && gwConfig.requesterAgentId) {
      payload.agentId = gwConfig.requesterAgentId;
    }
    const body = JSON.stringify(payload);
    const authHeader =
      gwConfig.mode === "token"
        ? "Bearer " + gwConfig.token
        : "Basic " + Buffer.from(":" + gwConfig.password).toString("base64");

    // Anthropic closes an idle tool-use turn at roughly five minutes. Return a
    // recoverable MCP error before that boundary instead of losing the entire
    // Claude turn with "Connection closed mid-response".
    const gatewayToolTimeoutMs = GATEWAY_TOOL_TIMEOUT_MS;
    const opts = {
      hostname: "127.0.0.1",
      port: gwConfig.port,
      path: "/tools/invoke",
      method: "POST",
      // Long-running tools (pdf/image analysis, image_generate) can take minutes;
      // without a deadline a hung gateway call would block the MCP client forever.
      timeout: gatewayToolTimeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: authHeader,
      },
    };

    let settled = false;
    let deadlineTimer = null;
    let response = null;
    const settle = (callback, value) => {
      if (settled) return false;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      callback(value);
      return true;
    };
    const succeed = (value) => settle(resolve, value);
    const fail = (error) => settle(reject, error);

    const req = http.request(opts, (res) => {
      response = res;
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("aborted", () => fail(new Error(`Gateway response aborted: ${toolName}`)));
      res.on("error", fail);
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          succeed(data);
          return;
        }
        if (parsed.ok === false || parsed.error) {
          const message = parsed.error?.message || "Tool invocation failed";
          // The masked-error read-back touches the filesystem; keep it off the
          // success path and let the deadline timer still win if it stalls.
          describeGatewayToolFailure(message, toolName, res.statusCode, startedAt)
            .then((described) => fail(new Error(described)))
            .catch(() => fail(new Error(message)));
        } else {
          succeed(parsed.result !== undefined ? parsed.result : parsed);
        }
      });
    });

    const onDeadline = () => {
      const error = new Error(
        `Gateway request timed out after ${gatewayToolTimeoutMs}ms: ${toolName}`,
      );
      error.code = "GATEWAY_TOOL_TIMEOUT";
      if (!fail(error)) return;
      req.destroy(error);
      if (response && !response.destroyed) response.destroy(error);
    };
    // http.request's `timeout` is a socket-idle timeout, not a wall-clock
    // deadline. Keep it as a secondary guard, but enforce the real deadline
    // explicitly so trickling or half-open responses cannot pin a Claude turn.
    deadlineTimer = setTimeout(onDeadline, gatewayToolTimeoutMs);
    deadlineTimer.unref?.();
    req.on("timeout", onDeadline);
    req.on("error", fail);
    req.write(body);
    req.end();
  });
}

// ── MCP JSON-RPC server ──────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (DYNAMIC_SESSIONS_ENABLED && (method === "initialize" || method === "tools/list")) {
    writeProxyDiagnostic("mcp_request", { method });
  }

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openclaw-proxy", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return; // no-op
  }

  if (method === "tools/list") {
    await upstreamToolsReady.catch(() => {});
    await craftToolsReady;
    return reply(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    if (!name) return replyError(id, -32602, "Missing tool name");
    if (!isToolAllowed(name)) {
      return replyError(id, -32601, "Tool is disabled by the server-side allowlist: " + name);
    }
    await upstreamToolsReady.catch(() => {});
    await craftToolsReady;

    try {
      // Preserve structuredContent, images and isError without stringifying them.
      if (craftBridge.has(name)) return reply(id, await craftBridge.call(name, args));
      let result;
      if (name === "sessions_send" && DYNAMIC_SESSIONS_ENABLED) {
        // Eve Desktop chats are direct Gateway agent turns. Routing them through
        // OpenClaw's generic sessions_send tool starts a background A2A announce
        // turn, which can write the same transcript after the next prompt begins.
        result = await invokeDirectAgent(args);
      } else if (LOCAL_TOOLS.has(name)) {
        const startedAt = Date.now();
        try {
          result = await invokeLocalTool(name, args);
          writeLocalToolLog({
            tool: name,
            outcome: "ok",
            durationMs: Date.now() - startedAt,
            ...localToolLogFields(args),
          });
        } catch (err) {
          writeLocalToolLog({
            tool: name,
            outcome: err?.code === "LOCAL_TOOL_TIMEOUT" ? "timeout" : "error",
            durationMs: Date.now() - startedAt,
            ...localToolLogFields(args),
            error: String(err?.message || err).slice(0, 500),
          });
          throw err;
        }
      } else if (upstreamToolRoutes.has(name)) {
        result = await invokeUpstreamTool(name, args);
      } else if (name === "sessions_yield") {
        // Return exact terminal replies here; never infer completion from a list
        // disappearance or depend on a host main-session notification.
        result = await simulatedYield(
          args?.timeoutMs,
          requesterContext.resolve(args?.sessionKey)
        );
      } else {
        let normalizedArgs = normalizeToolArgs(name, args);

        // For these tools, args.sessionKey is the *requester identity*, not a tool arg:
        // strip it from args and hoist to the /tools/invoke body top level so the
        // gateway records the right requester (spawnedBy → announce routing).
        // Tools like sessions_history/sessions_send/cron use sessionKey as a real
        // target arg and must NOT be hoisted.
        // The top-level sessionKey always identifies who is calling the Gateway
        // tool. For sessions_send, args.sessionKey remains the target while the
        // environment-provided requester identity is sent separately here.
        let hoistedSessionKey = DEFAULT_REQUESTER_SESSION_KEY;
        if (SESSION_IDENTITY_TOOLS.has(name) && normalizedArgs && normalizedArgs.sessionKey !== undefined) {
          hoistedSessionKey = requesterContext.resolve(normalizedArgs.sessionKey);
          const { sessionKey: _drop, ...rest } = normalizedArgs;
          normalizedArgs = rest;
        }
        if (name === "sessions_spawn" && normalizedArgs.expectsCompletionMessage === undefined
          && !normalizedArgs.completionTarget && !normalizedArgs.collect && !normalizedArgs.visible
          && !normalizedArgs.thread && normalizedArgs.mode !== "session" && normalizedArgs.runtime !== "acp") {
          // MCP callers retrieve the exact child reply with sessions_yield;
          // avoid a second automatic host-agent/channel completion turn.
          normalizedArgs = { ...normalizedArgs, expectsCompletionMessage: false };
        }
        result = await invokeGatewayTool(name, normalizedArgs, hoistedSessionKey);

        // Capture runId from sessions_spawn so sessions_yield can poll for it
        if (name === "sessions_spawn") {
          try {
            let obj = typeof result === "string" ? JSON.parse(result) : result;
            // Handle MCP content wrapper: {content: [{type: "text", text: "{...json...}"}]}
            if (!obj?.runId && obj?.content?.[0]?.text) {
              try { obj = JSON.parse(obj.content[0].text); } catch (_) {}
            }
            if (obj?.status === "accepted" && obj?.runId && obj?.childSessionKey) {
              pendingYieldStore.write(obj.runId, hoistedSessionKey, { childSessionKey: obj.childSessionKey });
              process.stderr.write("[openclaw-mcp] sessions_spawn: captured runId=" + obj.runId + " sessionKey=" + (hoistedSessionKey || "(none)") + "\n");
            } else {
              process.stderr.write("[openclaw-mcp] sessions_spawn: no runId found in result: " + JSON.stringify(obj).slice(0, 300) + "\n");
            }
          } catch (e) {
            process.stderr.write("[openclaw-mcp] sessions_spawn: capture error: " + e.message + "\n");
          }
        }
      }
      // Native MCP-shaped results may contain images and tool-level errors.
      // Preserve them rather than double-wrapping as successful JSON text.
      if (result && typeof result === "object" && Array.isArray(result.content)) return reply(id, result);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const response = {
        content: [{ type: "text", text }],
        isError: name === "sessions_send" && DYNAMIC_SESSIONS_ENABLED && result?.status !== "ok",
      };
      if (name === "sessions_send" && DYNAMIC_SESSIONS_ENABLED) response.structuredContent = result;
      if (name === "sessions_start" && result && typeof result === "object") {
        response.structuredContent = result;
      }
      return reply(id, response);
    } catch (err) {
      writeProxyDiagnostic("tool_call_error", {
        name: String(name || ""),
        error: String(err?.message || err).slice(0, 300),
      });
      return reply(id, {
        content: [{ type: "text", text: "Error: " + err.message }],
        isError: true,
      });
    }
  }

  if (method === "ping") {
    return reply(id, {});
  }

  // Unknown method — return not-found
  if (id != null) {
    replyError(id, -32601, "Method not found: " + method);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

process.stdout.on("error", (err) => {
  writeProxyDiagnostic("stdout_error", { code: String(err?.code || ""), error: String(err?.message || err).slice(0, 300) });
  if (err?.code === "EPIPE") process.exit(0);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  writeProxyDiagnostic("uncaught_exception", { error: String(err?.stack || err).slice(0, 1000) });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  writeProxyDiagnostic("unhandled_rejection", { error: String(reason?.stack || reason).slice(0, 1000) });
  process.exit(1);
});

process.on("exit", (code) => {
  craftBridge.close();
  for (const [, proc] of bgSessions) {
    if (proc.runtimeTimer) clearTimeout(proc.runtimeTimer);
    signalProcessTree(proc.child, "SIGTERM");
  }
  writeProxyDiagnostic("process_exit", { code });
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write("[openclaw-mcp] Invalid JSON: " + trimmed + "\n");
    return;
  }
  try {
    await handleRequest(msg);
  } catch (e) {
    process.stderr.write("[openclaw-mcp] Handler error: " + e.message + "\n");
    if (msg.id != null) replyError(msg.id, -32603, e.message);
  }
});

rl.on("close", () => {
  writeProxyDiagnostic("stdin_closed");
  process.exit(0);
});

writeProxyDiagnostic("process_start", {
  gatewayPort: gwConfig.port,
  sessionsSendMaxTimeoutSeconds: DESKTOP_SESSIONS_SEND_MAX_TIMEOUT_SECONDS,
  sessionsSendHardDeadlineMs: DESKTOP_SESSIONS_SEND_HARD_DEADLINE_MS,
  sessionsSendCleanupGraceMs: DESKTOP_SESSIONS_SEND_CLEANUP_GRACE_MS,
});
process.stderr.write("[openclaw-mcp] Proxy started — gateway port " + gwConfig.port + "\n");
