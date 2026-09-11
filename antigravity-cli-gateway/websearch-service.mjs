#!/usr/bin/env node
// Antigravity Web Search Service — gemini-provider-shaped web_search over the
// Antigravity CLI's subscription-grounded search_web tool.
//
// Contract: request body and response payload mirror what the bundled OpenClaw
// gemini web-search provider's tool execute() accepts and returns (verified
// against OpenClaw 2026.9.3 dist), so a future OpenClaw provider plugin (or the
// Dalton web-search broker) can consume this endpoint as a drop-in:
//
//   POST /v1/web-search   {"query", "count", "freshness", "date_after", "date_before"}
//   →  {query, provider:"gemini", model, tookMs, externalContent{...}, content, citations[, cached]}
//   Parameter errors return the provider's own {error, message, docs} shapes with HTTP 200.
//
// Translation: freshness=day / date ranges become query-text instructions
// (soft filters); the underlying grounding backend is the same Vertex
// Google-Search grounding the Gemini API uses, so citation URLs are the same
// grounding-api-redirect links and are resolved to direct URLs here.
//
// Everything binds to 127.0.0.1 only. Node ≥ 20, no dependencies.

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.AGY_SEARCH_PORT || 4570);
const HOST = "127.0.0.1";
const API_KEY = process.env.AGY_SEARCH_API_KEY || "";
const AGY_BIN = process.env.AGY_CLI_BIN || join(process.env.HOME || "", ".local/bin/agy");
const AGENT_NAME = process.env.AGY_SEARCH_AGENT || "websearch";
const MODEL = process.env.AGY_SEARCH_MODEL || "gemini-3.8-flash";
const EFFORT = process.env.AGY_SEARCH_EFFORT || "low";
const TIMEOUT_MS = Number(process.env.AGY_SEARCH_TIMEOUT_MS || 90_000);
const STALL_MS = Number(process.env.AGY_SEARCH_STALL_MS || 60_000);
const MAX_CONCURRENT = Number(process.env.AGY_SEARCH_MAX_CONCURRENT || 8);
const QUEUE_TIMEOUT_MS = Number(process.env.AGY_SEARCH_QUEUE_TIMEOUT_MS || 60_000);
const MAX_BODY_BYTES = Number(process.env.AGY_SEARCH_MAX_BODY_BYTES || 65_536);
const MAX_QUERY_CHARS = Number(process.env.AGY_SEARCH_MAX_QUERY_CHARS || 1000);
const MAX_RESPONSE_BYTES = Number(process.env.AGY_SEARCH_MAX_RESPONSE_BYTES || 262_144);
const CACHE_TTL_MS = Number(process.env.AGY_SEARCH_CACHE_TTL_MS === undefined ? 900_000 : process.env.AGY_SEARCH_CACHE_TTL_MS);
const CACHE_MAX_ENTRIES = Number(process.env.AGY_SEARCH_CACHE_MAX_ENTRIES || 500);
const REDIRECT_TIMEOUT_MS = Number(process.env.AGY_SEARCH_REDIRECT_TIMEOUT_MS || 8000);
const REDIRECT_MAX_HOPS = 5;
const AGENT_INSTALL_DIR = join(process.env.HOME || "", ".gemini/config/agents");
const AGENT_INSTALL_PATH = join(AGENT_INSTALL_DIR, `${AGENT_NAME}.md`);
const CWD = process.env.AGY_SEARCH_CWD || join(SCRIPT_DIR, "websearch-cwd");

const DOCS = "https://docs.openclaw.ai/tools/web";
// The provider id reported in payloads. "gemini" keeps the output byte-for-byte
// compatible with the bundled provider (the Dalton broker pins this value);
// override when wiring this up as a distinct OpenClaw provider.
const PROVIDER_ID = process.env.AGY_SEARCH_PROVIDER_ID || "gemini";

// ---------------------------------------------------------------------------
// Logging — [AGYWS] events to stdout, mirroring the gateway's [AGYGW] style.
// Queries are truncated, answers are never logged.

function log(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  process.stdout.write(`[AGYWS] ${line}\n`);
}

function truncateText(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// External-content envelope — replicates OpenClaw 2026.9.3's
// wrapWebContent(path with source="web_search") so `content` is byte-compatible
// with what executeGeminiSearch returns. Simplification: marker sanitization
// detects on NFKC-folded text but replaces on the original (OpenClaw keeps a
// full fold index map); ASCII markers — the overwhelmingly common case — are
// handled identically.

const EXTERNAL_CONTENT_START_NAME = "EXTERNAL_UNTRUSTED_CONTENT";
const EXTERNAL_CONTENT_END_NAME = "END_EXTERNAL_UNTRUSTED_CONTENT";
const START_MARKER_RE = /<<<\s*EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT(?:\s+id=\\*"[^"]*")?\s*>>>/gi;
const END_MARKER_RE = /<<<\s*END[\s_]+EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT(?:\s+id=\\*"[^"]*")?\s*>>>/gi;
const SPECIAL_TOKENS = [
  "<|im_start|>", "<|im_end|>", "<|endoftext|>", "<|begin_of_text|>", "<|end_of_text|>",
  "<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>", "<|python_tag|>", "<|eom_id|>",
  "[INST]", "[/INST]", "<<SYS>>", "<</SYS>>", "<s>", "</s>",
  "<|channel|>", "<|message|>", "<|return|>", "<|call|>", "<start_of_turn>", "<end_of_turn>",
];
const SPECIAL_TOKEN_RE = new RegExp(
  [...SPECIAL_TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), /<\|reserved_special_token_\d+\|>/.source].join("|"),
  "g",
);
const SPECIAL_TOKEN_REPLACEMENT = "[REMOVED_SPECIAL_TOKEN]";

function sanitizeExternalContentText(content) {
  let text = String(content ?? "");
  const folded = text.normalize("NFKC");
  if (/external[\s_]+untrusted[\s_]+content/i.test(folded)) {
    text = text.replace(START_MARKER_RE, "[[MARKER_SANITIZED]]").replace(END_MARKER_RE, "[[END_MARKER_SANITIZED]]");
  }
  return text.replace(SPECIAL_TOKEN_RE, SPECIAL_TOKEN_REPLACEMENT);
}

function wrapWebContent(content) {
  // web_search payloads carry no SECURITY NOTICE block in OpenClaw
  // (includeWarning is only true for web_fetch).
  const markerId = randomBytes(8).toString("hex");
  return [
    `<<<${EXTERNAL_CONTENT_START_NAME} id="${markerId}">>>`,
    "Source: Web Search",
    "---",
    sanitizeExternalContentText(content),
    `<<<${EXTERNAL_CONTENT_END_NAME} id="${markerId}">>>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parameter validation — mirrors resolveGeminiTimeRangeFilter +
// buildUnsupportedSearchFilterResponse + parseWebSearchTimeFilters from the
// bundled gemini provider (exact error codes and message wording).

const FRESHNESS_SHORTCUTS = { pd: "day", pw: "week", pm: "month", py: "year" };

function providerError(error, message, docs = DOCS) {
  const payload = { error, message };
  if (docs) payload.docs = docs;
  return payload;
}

function normalizeFreshness(raw) {
  const lowered = String(raw).trim().toLowerCase();
  if (["day", "week", "month", "year"].includes(lowered)) return lowered;
  return FRESHNESS_SHORTCUTS[lowered];
}

function isoDateStart(date) {
  return `${date}T00:00:00.000Z`;
}

function parseArgs(args) {
  if (typeof args.query !== "string" || !args.query.trim()) {
    return providerError("missing_query", "query is required.");
  }
  if (args.query.length > MAX_QUERY_CHARS) {
    return providerError("invalid_query", `query must be at most ${MAX_QUERY_CHARS} characters.`);
  }
  if (args.count !== undefined) {
    if (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > 10) {
      return providerError("invalid_count", "count must be an integer from 1 to 10.");
    }
  }
  // gemini rejects country/language with these exact shapes.
  for (const name of ["country", "language"]) {
    if (typeof args[name] === "string" && args[name].trim()) {
      const label = name === "country" ? "country filtering" : "language filtering";
      return providerError(`unsupported_${name}`, `${label} is not supported by the ${PROVIDER_ID} provider. Only Brave and Perplexity support ${label}.`);
    }
  }

  const rawFreshness = typeof args.freshness === "string" && args.freshness.trim() ? args.freshness : undefined;
  const rawDateAfter = typeof args.date_after === "string" && args.date_after.trim() ? args.date_after : undefined;
  const rawDateBefore = typeof args.date_before === "string" && args.date_before.trim() ? args.date_before : undefined;

  if (rawFreshness && !normalizeFreshness(rawFreshness)) {
    return providerError("invalid_freshness", "freshness must be day, week, month, year, or the shortcuts pd, pw, pm, py.");
  }
  if (rawFreshness && (rawDateAfter || rawDateBefore)) {
    return providerError("conflicting_time_filters", "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.");
  }
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  for (const [name, value] of [["date_after", rawDateAfter], ["date_before", rawDateBefore]]) {
    if (value && !ISO_DATE.test(value)) {
      return providerError(`invalid_${name}`, `${name} must be YYYY-MM-DD format.`);
    }
  }
  if (rawDateAfter && rawDateBefore && rawDateAfter >= rawDateBefore) {
    return providerError("invalid_date_range", "date_after must be before date_before.");
  }
  return { query: args.query, freshness: rawFreshness ? normalizeFreshness(rawFreshness) : undefined, dateAfter: rawDateAfter, dateBefore: rawDateBefore };
}

// ---------------------------------------------------------------------------
// Query translation. freshness=day uses the gemini provider's exact soft
// recency wording; wider windows and explicit dates become time-range
// instructions in the query text (agy's search_web has no timeRangeFilter
// parameter, so these stay soft — see README).

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function translateQuery(parsed) {
  const { query, freshness, dateAfter, dateBefore } = parsed;
  if (freshness === "day") {
    return `${query}\n\nSearch recency instruction: Prioritize web sources published in the last 24 hours. If no matching recent sources are available, state that limitation and use the most relevant available sources.`;
  }
  if (freshness) {
    const now = new Date();
    const start = new Date(now);
    if (freshness === "week") start.setUTCDate(start.getUTCDate() - 7);
    else if (freshness === "month") start.setUTCMonth(start.getUTCMonth() - 1);
    else start.setUTCFullYear(start.getUTCFullYear() - 1);
    const span = freshness === "week" ? "last 7 days" : freshness === "month" ? "last month" : "last year";
    return `${query}\n\nSearch time range instruction: Only use sources published between ${ymd(start)} and ${ymd(now)} (${span}). If no matching sources in this range are available, state that limitation and use the most relevant available sources.`;
  }
  if (dateAfter || dateBefore) {
    const start = dateAfter || "1970-01-01";
    const end = dateBefore || ymd(new Date());
    return `${query}\n\nSearch time range instruction: Only use sources published between ${start} and ${end} (the specified date range). If no matching sources in this range are available, state that limitation and use the most relevant available sources.`;
  }
  return query;
}

// ---------------------------------------------------------------------------
// Citation redirect resolution — HEAD + manual redirect following with strict
// SSRF checks (public http/https targets only), falling back to the original
// URL on any failure, mirroring the gemini provider's resolveCitationRedirectUrl.

function isPublicAddress(address) {
  if (address.family === 6) {
    const lower = address.address.toLowerCase();
    if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return false;
    return true;
  }
  const [a, b] = address.address.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 198 && b >= 18 && b <= 19) return false;
  return true;
}

async function assertPublicHost(hostname) {
  const addresses = await dnsLookup(hostname, { all: true });
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error("blocked host");
}

async function resolveCitationRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return url;
    let current = url;
    for (let hop = 0; hop < REDIRECT_MAX_HOPS; hop += 1) {
      const target = new URL(current);
      if (!/^https?:$/.test(target.protocol)) return url;
      await assertPublicHost(target.hostname);
      const response = await fetch(target, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
      });
      const location = response.headers.get("location");
      if (!location || !response.status.toString().startsWith("3")) return current;
      current = new URL(location, target).toString();
    }
    return current;
  } catch {
    return url;
  }
}

async function resolveCitations(citations) {
  const resolved = [];
  for (let index = 0; index < citations.length; index += 16) {
    const batch = citations.slice(index, index + 8);
    resolved.push(...await Promise.all(batch.map(async (citation) => ({ ...citation, url: await resolveCitationRedirectUrl(citation.url) }))));
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// agy execution — spawns the headless search agent and parses the stream-json
// protocol (init agent guard, search_web grounding guard, result event).

function runAgySearch(translatedQuery) {
  return new Promise((resolve, reject) => {
    const args = [
      "--agent", AGENT_NAME,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--model", MODEL,
      "--effort", EFFORT,
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
      "--print-timeout", `${Math.ceil(TIMEOUT_MS / 1000) + 60}s`,
    ];
    const child = spawn(AGY_BIN, args, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdin.end(`${JSON.stringify({
      event: "user",
      message: { role: "user", content: [{ type: "text", text: translatedQuery }] },
    })}\n`);

    let buffer = "";
    let stderrTail = "";
    let sawAgent = false;
    let searchCalls = 0;
    let result = null;
    let settled = false;
    let lastActivity = Date.now();
    const stallTimer = setInterval(() => {
      if (Date.now() - lastActivity > STALL_MS) finish(new Error(`AGY_SEARCH_STALL: no output for ${STALL_MS}ms`));
    }, 5000);
    const timeoutTimer = setTimeout(() => finish(new Error(`AGY_SEARCH_TIMEOUT: exceeded ${TIMEOUT_MS}ms`)), TIMEOUT_MS);

    function finish(error, payload) {
      if (settled) return;
      settled = true;
      clearInterval(stallTimer);
      clearTimeout(timeoutTimer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(payload);
    }

    child.stdout.on("data", (chunk) => {
      lastActivity = Date.now();
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event === "init") {
          if (event.init?.agent !== AGENT_NAME) {
            finish(new Error(`AGY_AGENT_NOT_APPLIED: init reports agent ${JSON.stringify(event.init?.agent)}; expected "${AGENT_NAME}". Install it with: node websearch-service.mjs --install-agent`));
            return;
          }
          sawAgent = true;
        } else if (event.event === "step_update" && event.step_update?.step_type === "tool") {
          const step = event.step_update;
          if (step.tool_info?.name === "search_web" && step.state === "DONE") searchCalls += 1;
        } else if (event.event === "result") {
          result = event.result ?? {};
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-600);
    });

    child.on("close", (code) => {
      if (!result) {
        const detail = code !== 0 ? ` (exit ${code})` : "";
        finish(new Error(`AGY_SEARCH_ERROR: agy exited without a result${detail}: ${truncateText(stderrTail.trim(), 300)}`));
        return;
      }
      if (result.status !== "SUCCESS") {
        finish(new Error(`AGY_SEARCH_ERROR: result status ${result.status}: ${truncateText(result.response, 300)}`));
        return;
      }
      if (!sawAgent) {
        finish(new Error('AGY_AGENT_NOT_APPLIED: stream carried no init agent; expected "websearch". Install it with: node websearch-service.mjs --install-agent'));
        return;
      }
      if (searchCalls < 1) {
        finish(new Error("AGY_SEARCH_UNGROUNDED: agy completed without calling search_web"));
        return;
      }
      finish(null, { response: result.response ?? "", usage: result.usage, durationSeconds: result.duration_seconds, searchCalls });
    });
  });
}

// ---------------------------------------------------------------------------
// Response parsing — the agent replies with ONLY a JSON object (code fences
// tolerated), which is unwrapped and validated here.

function extractJsonObject(text) {
  let candidate = String(text ?? "").trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseAgentAnswer(response) {
  const parsed = extractJsonObject(response);
  if (!parsed || typeof parsed.answer !== "string" || !parsed.answer.trim()) return null;
  const citations = [];
  if (Array.isArray(parsed.citations)) {
    for (const citation of parsed.citations) {
      if (!citation || typeof citation !== "object") continue;
      if (typeof citation.url !== "string") continue;
      try {
        const url = new URL(citation.url);
        if (!/^https?:$/.test(url.protocol)) continue;
        citations.push({ url: url.toString(), ...(typeof citation.title === "string" && citation.title ? { title: citation.title } : {}) });
      } catch {
        // skip malformed citation URLs
      }
    }
  }
  return { answer: parsed.answer, citations };
}

// ---------------------------------------------------------------------------
// Result cache — TTL keyed by the translated request (same identity the gemini
// provider uses: query + effective time filters + model).

const cache = new Map();

function cacheKeyFor(parsed, translatedQuery) {
  return createHash("sha256").update(JSON.stringify({ translatedQuery, model: MODEL, effort: EFFORT, provider: PROVIDER_ID })).digest("hex");
}

function cacheGet(key) {
  if (CACHE_TTL_MS <= 0) return undefined;
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.payload;
}

function cachePut(key, payload) {
  if (CACHE_TTL_MS <= 0) return;
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { payload, storedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Concurrency queue.

let active = 0;
const queue = [];

function acquireSlot() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const ticket = { resolve, reject, timer: setTimeout(() => {
      const index = queue.indexOf(ticket);
      if (index !== -1) queue.splice(index, 1);
      reject(new Error(`AGY_SEARCH_BUSY: queue timeout after ${QUEUE_TIMEOUT_MS}ms`));
    }, QUEUE_TIMEOUT_MS) };
    queue.push(ticket);
  });
}

function releaseSlot() {
  active -= 1;
  const next = queue.shift();
  if (next) {
    active += 1;
    clearTimeout(next.timer);
    next.resolve();
  }
}

// ---------------------------------------------------------------------------
// Search execution pipeline.

async function executeSearch(args) {
  const parsed = parseArgs(args);
  if (parsed.error) return parsed;
  const translatedQuery = translateQuery(parsed);
  const cacheKey = cacheKeyFor(parsed, translatedQuery);
  const cached = cacheGet(cacheKey);
  if (cached) {
    log("cached", { query: truncateText(parsed.query, 120) });
    return { ...cached, cached: true };
  }

  const startedAt = Date.now();
  log("request", { query: truncateText(parsed.query, 120), freshness: parsed.freshness, dateAfter: parsed.dateAfter, dateBefore: parsed.dateBefore });
  log("translate", { query: truncateText(translatedQuery, 200) });

  let run;
  try {
    await acquireSlot();
  } catch (error) {
    // Saturation surfaces exactly like a Gemini API rate limit: same
    // "Gemini API error (429): …" message format, so downstream classifiers
    // (OpenClaw error paths, the Dalton broker's rate-limit token match)
    // treat it identically to the native provider being throttled.
    log("busy", { query: truncateText(parsed.query, 120), active, maxConcurrent: MAX_CONCURRENT, queueWaitMs: Date.now() - startedAt });
    return providerError(
      "agy_search_busy",
      `Gemini API error (429): rate limit exceeded — ${active} searches in flight (service max ${MAX_CONCURRENT}), queue wait exceeded ${QUEUE_TIMEOUT_MS}ms. Retry the search shortly.`,
    );
  }
  try {
    run = await runAgySearch(translatedQuery);
  } catch (error) {
    log("error", { message: truncateText(error.message, 300), tookMs: Date.now() - startedAt });
    const message = error.message.slice(0, 300);
    if (message.startsWith("AGY_SEARCH_UNGROUNDED")) return providerError("agy_search_ungrounded", message);
    if (message.startsWith("AGY_AGENT_NOT_APPLIED")) return providerError("agy_agent_not_applied", message);
    return providerError("agy_search_error", message);
  } finally {
    releaseSlot();
  }

  const parsedAnswer = parseAgentAnswer(run.response);
  if (!parsedAnswer) {
    log("error", { message: "agent response was not the expected JSON contract", tookMs: Date.now() - startedAt });
    return providerError("agy_search_parse_error", "agy search agent returned a response that did not match the {answer, citations} JSON contract.");
  }

  const citations = await resolveCitations(parsedAnswer.citations);
  const payload = {
    query: parsed.query,
    provider: PROVIDER_ID,
    model: MODEL.includes("-") && /\b(high|medium|low)\b/.test(MODEL) ? MODEL : `${MODEL}-${EFFORT}`,
    tookMs: Date.now() - startedAt,
    externalContent: { untrusted: true, source: "web_search", provider: PROVIDER_ID, wrapped: true },
    content: wrapWebContent(parsedAnswer.answer),
    citations,
  };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_RESPONSE_BYTES) {
    return providerError("agy_search_too_large", "search result exceeds the configured response limit.");
  }
  cachePut(cacheKey, payload);
  log("done", { tookMs: payload.tookMs, agySeconds: run.durationSeconds, searchCalls: run.searchCalls, usage: run.usage, citations: citations.length, cached: false });
  return payload;
}

// ---------------------------------------------------------------------------
// HTTP server.

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function agyVersion() {
  try {
    return spawnSync(AGY_BIN, ["--version"], { encoding: "utf8", timeout: 15000 }).stdout?.trim() || null;
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  if (API_KEY && request.headers.authorization !== `Bearer ${API_KEY}`) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      agyCli: agyVersion(),
      agent: AGENT_NAME,
      agentInstalled: existsSync(AGENT_INSTALL_PATH),
      model: MODEL,
      effort: EFFORT,
      providerId: PROVIDER_ID,
      activeRequests: active,
      queuedRequests: queue.length,
      maxConcurrent: MAX_CONCURRENT,
      timeoutMs: TIMEOUT_MS,
      cacheTtlMs: CACHE_TTL_MS,
      cacheEntries: cache.size,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/web-search") {
    let body;
    try {
      body = JSON.parse(await readBody(request) || "{}");
    } catch (error) {
      sendJson(response, 400, { error: "invalid_json", message: error.message });
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendJson(response, 400, { error: "invalid_request", message: "request body must be a JSON object" });
      return;
    }
    // Provider-shaped error payloads travel over HTTP 200, exactly like the
    // gemini provider returns error objects from execute().
    sendJson(response, 200, await executeSearch(body));
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

// ---------------------------------------------------------------------------
// Entrypoint.

function installAgent() {
  const source = join(SCRIPT_DIR, "websearch-agent.md");
  if (!existsSync(source)) {
    console.error(`bundled agent definition not found: ${source}`);
    process.exit(1);
  }
  if (existsSync(AGENT_INSTALL_PATH)) {
    console.error(`refusing to overwrite existing ${AGENT_INSTALL_PATH}; review and remove it first`);
    process.exit(1);
  }
  mkdirSync(AGENT_INSTALL_DIR, { recursive: true });
  copyFileSync(source, AGENT_INSTALL_PATH);
  console.log(`installed ${AGENT_INSTALL_PATH}`);
}

if (process.argv.includes("--install-agent")) {
  installAgent();
} else {
  mkdirSync(CWD, { recursive: true });
  if (!existsSync(AGENT_INSTALL_PATH)) {
    log("warning", { message: `agent "${AGENT_NAME}" is not installed at ${AGENT_INSTALL_PATH}; searches will fail. Run: node websearch-service.mjs --install-agent` });
  }
  server.listen(PORT, HOST, () => {
    log("start", { host: HOST, port: PORT, agyBin: AGY_BIN, agent: AGENT_NAME, model: MODEL, effort: EFFORT, providerId: PROVIDER_ID, maxConcurrent: MAX_CONCURRENT, timeoutMs: TIMEOUT_MS, cacheTtlMs: CACHE_TTL_MS });
  });
}
