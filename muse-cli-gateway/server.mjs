#!/usr/bin/env node
// OpenAI-compatible local façade over official Muse Code, like the sibling
// Claude/Antigravity gateways. No model API or subscription-token extraction.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODEL, EFFORTS, failure, readToolNames, translateRequest } from './request.mjs';
import { runMuse, sanitizeError, subscriptionStatus } from './process.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function envNumber(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
const HOME_DIR = os.homedir();
const PORT = envNumber('MUSE_CLI_GATEWAY_PORT', 4571, 1, 65535);
const LIMIT = envNumber('MUSE_CLI_GATEWAY_MAX_CONCURRENT', 2, 1, 16);
const QUEUE_MS = envNumber('MUSE_CLI_GATEWAY_QUEUE_TIMEOUT_MS', 120000, 100, 600000);
const MAX_BODY = envNumber('MUSE_CLI_GATEWAY_MAX_BODY_BYTES', 32 * 1024 ** 2, 1024, 128 * 1024 ** 2);
const MAX_PROMPT = envNumber('MUSE_CLI_GATEWAY_MAX_PROMPT_BYTES', 2_000_000, 1000, 10_000_000);
const API_KEY = process.env.MUSE_CLI_GATEWAY_API_KEY ?? '';
const config = {
  cliBin: process.env.MUSE_CLI_BIN ?? path.join(HOME_DIR, '.local/bin/muse'),
  authPath: process.env.MUSE_CLI_GATEWAY_AUTH_PATH ?? path.join(HOME_DIR, '.config/muse/auth.json'),
  stateDir: process.env.MUSE_CLI_GATEWAY_STATE_DIR ?? path.join(HOME_DIR, '.openclaw/state/muse-cli-gateway'),
  workspace: process.env.OPENCLAW_WORKSPACE ?? path.join(HOME_DIR, '.openclaw/workspace'),
  proxyPath: process.env.MUSE_CLI_GATEWAY_MCP_PROXY ?? path.resolve(HERE, '../openclaw-mcp-proxy/server.js'),
  timeoutMs: envNumber('MUSE_CLI_GATEWAY_TIMEOUT_MS', 1800000, 100, 7200000),
  stallMs: envNumber('MUSE_CLI_GATEWAY_STALL_MS', 300000, 100, 1800000),
  exitGraceMs: envNumber('MUSE_CLI_GATEWAY_EXIT_GRACE_MS', 15000, 100, 60000),
  execTimeoutMs: envNumber('MUSE_CLI_GATEWAY_EXEC_MAX_TIMEOUT_MS', 600000, 1000, 1800000),
  maxSteps: envNumber('MUSE_CLI_GATEWAY_MAX_MODEL_STEPS', 100, 1, 500),
};
const knownTools = readToolNames(path.join(path.dirname(config.proxyPath), 'tools-schema.json'));
const versionCheck = spawnSync(config.cliBin, ['--version'], { encoding: 'utf8', timeout: 15000 });
const cliVersion = versionCheck.status === 0 ? versionCheck.stdout.trim() : null;
let active = 0;
const waiters = [], requests = new Set();
const log = (request, event, details = {}) => process.stdout.write('[MUSEGW] ' + JSON.stringify({ v: 1, ts: new Date().toISOString(), request, event, ...details }) + '\n');

function acquire(signal) {
  if (signal.aborted) return Promise.reject(failure('Request cancelled', 'MUSE_CANCELLED', 499));
  if (active < LIMIT) { active++; return Promise.resolve(release); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const remove = () => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const fail = e => { if (settled) return; settled = true; remove(); reject(e); };
    const abort = () => fail(failure('Queued request cancelled', 'MUSE_CANCELLED', 499));
    const waiter = () => { if (settled) return; settled = true; remove(); active++; resolve(release); };
    const timer = setTimeout(() => fail(failure('Muse gateway queue timed out', 'MUSE_QUEUE_TIMEOUT', 503)), QUEUE_MS);
    timer.unref(); waiters.push(waiter); signal.addEventListener('abort', abort, { once: true });
  });
}
function release() { active--; waiters[0]?.(); }
function json(res, status, data) {
  if (res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function errorBody(error) { return { error: { message: sanitizeError(error.message), type: 'muse_cli_error', code: error.code ?? 'MUSE_ERROR', param: null } }; }
async function readBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) throw failure('Request exceeds body limit', 'MUSE_BODY_LIMIT', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('Request body must be valid JSON'); }
}
function sse(res, value) { if (!res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`); }
async function chat(req, res, body) {
  const job = translateRequest(body, { maxPromptBytes: MAX_PROMPT, knownTools });
  if (!subscriptionStatus(config.authPath).ready) throw failure('Official Muse device login is required; API-key fallback is disabled', 'MUSE_SUBSCRIPTION_AUTH_REQUIRED', 503);
  const controller = new AbortController(); requests.add(controller);
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  req.on('aborted', disconnected); res.on('close', disconnected);
  const requestId = randomUUID(), created = Math.floor(Date.now() / 1000), started = Date.now();
  const id = `chatcmpl-muse-cli-${requestId}`;
  const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta, finish_reason }] });
  let slot, heartbeat;
  try {
    slot = await acquire(controller.signal);
    if (controller.signal.aborted) throw failure('Request cancelled', 'MUSE_CANCELLED', 499);
    log(requestId, 'start', { model: MODEL, effort: job.effort, session: job.requesterSessionKey ?? null, tools: job.allowedTools, imageCount: job.images.length, promptBytes: Buffer.byteLength(job.prompt), auth: 'official-muse-device-login' });
    if (job.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      sse(res, chunk({ role: 'assistant', content: '' }));
      heartbeat = setInterval(() => sse(res, chunk({ reasoning_content: `[Muse CLI still running: ${Math.round((Date.now() - started) / 1000)}s]\n` })), 30000);
      heartbeat.unref();
    }
    const result = await runMuse(job, config, {
      signal: controller.signal,
      onEvent: (event, data) => {
        log(requestId, event, data);
        if (job.stream && event === 'tool_result') sse(res, chunk({ reasoning_content: '[Muse CLI tool completed]\n' }));
      },
    });
    if (job.stream) {
      // Deliver only the verified foreground final. Prose emitted before a tool
      // failure is not an answer, and unknown token usage is never fabricated.
      sse(res, chunk({ content: result.text }));
      sse(res, chunk({}, 'stop'));
      if (!res.destroyed) res.end('data: [DONE]\n\n');
    } else json(res, 200, { id, object: 'chat.completion', created, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }] });
    log(requestId, 'done', { model: result.model, museSessionId: result.sessionId, durationMs: Date.now() - started, responseChars: result.text.length, usageAvailable: false });
  } catch (e) {
    log(requestId, 'error', { code: e.code ?? 'MUSE_ERROR', message: sanitizeError(e.message), durationMs: Date.now() - started });
    if (res.headersSent) { sse(res, errorBody(e)); if (!res.destroyed) res.end('data: [DONE]\n\n'); }
    else throw e;
  } finally {
    clearInterval(heartbeat); slot?.(); requests.delete(controller);
    req.removeListener('aborted', disconnected); res.removeListener('close', disconnected);
  }
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: { message: 'Browser-origin requests are not accepted' } });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      const auth = subscriptionStatus(config.authPath);
      return json(res, cliVersion && auth.ready ? 200 : 503, { status: cliVersion && auth.ready ? 'ok' : 'degraded', cliVersion, auth, activeRequests: active, queuedRequests: waiters.length, maxConcurrent: LIMIT, model: MODEL, input: ['text', 'image'], reasoningEfforts: EFFORTS, usageAvailable: false });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'meta-via-official-muse-code' }] });
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) return json(res, 401, { error: { message: 'Invalid gateway credential' } });
      return await chat(req, res, await readBody(req));
    }
    return json(res, 404, { error: { message: 'Not found' } });
  } catch (e) { return json(res, e.statusCode ?? 502, errorBody(e)); }
});
server.requestTimeout = 0; server.headersTimeout = 30000;
server.listen(PORT, '127.0.0.1', () => log(null, 'listening', { port: PORT, maxConcurrent: LIMIT, model: MODEL, cliVersion }));
function shutdown() { server.close(() => process.exit(0)); for (const controller of requests) controller.abort(); setTimeout(() => process.exit(1), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
