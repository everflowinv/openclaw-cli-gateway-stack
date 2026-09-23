import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { failure, MODEL } from './request.mjs';
import { collectUsage } from './usage.mjs';

export function subscriptionStatus(authPath) {
  try {
    const profile = JSON.parse(fs.readFileSync(authPath, 'utf8'))?.providers?.meta;
    const ready = profile?.mechanism === 'oauth' && profile?.obtained_via === 'device_code' && profile?.storage === 'keychain' && profile?.api_base_url === 'https://api.meta.ai/v1';
    return { ready, mechanism: profile?.mechanism ?? null, storage: profile?.storage ?? null, source: ready ? 'official-muse-device-login' : 'unverified' };
  } catch { return { ready: false, mechanism: null, storage: null, source: 'missing' }; }
}

export function sanitizeError(value) {
  return String(value ?? '').replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access_token|refresh_token|device_code)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]').slice(-4000);
}

// This consumes only the foreground run's authoritative terminal record. A CLI
// exit code of zero or a reminder/subagent completion is not a successful turn.
export class MuseEvents {
  constructor(callbacks = {}, expectedModel = MODEL) { this.callbacks = callbacks; this.expectedModel = expectedModel; this.runId = null; this.modelSeen = false; this.text = ''; this.terminal = null; this.sessionId = null; }
  accept(event) {
    const p = event?.payload;
    if (!p || typeof p !== 'object') return;
    if (event.payload_type === 'run.model.configured') {
      if (this.runId && this.runId !== p.run_stream?.id) return;
      if (p.provider_id !== 'meta' || p.model_id !== this.expectedModel) throw failure('Muse selected an unexpected provider/model', 'MUSE_MODEL_MISMATCH', 502);
      this.runId = p.run_stream?.id;
      this.sessionId = event.stream?.id;
      this.modelSeen = true;
      this.callbacks.onEvent?.('model', { model: p.model_id, sessionId: this.sessionId });
      return;
    }
    if (!this.runId || p.run_stream?.id !== this.runId) return;
    if (event.payload_type === 'run.output.delta' && typeof p.text === 'string') {
      this.text += p.text;
      this.callbacks.onText?.(p.text);
    } else if (event.payload_type === 'tool.result') {
      this.callbacks.onEvent?.('tool_result', { callId: p.call_id });
    } else if (event.payload_type?.startsWith('task.lifecycle.')) {
      this.callbacks.onActivity?.();
    } else if (event.payload_type?.startsWith('run.terminal.')) {
      if (this.terminal) throw failure('Duplicate Muse terminal record', 'MUSE_PROTOCOL_ERROR', 502);
      this.terminal = p;
      this.callbacks.onTerminal?.(p);
    }
  }
  result(exitCode) {
    if (!this.modelSeen || !this.terminal) throw failure('Muse exited without a verified model and terminal result', 'MUSE_INCOMPLETE_TURN', 502);
    if (this.terminal.terminal !== 'completed' || exitCode !== 0) {
      const reason = sanitizeError(this.terminal.reason ?? `Muse turn ${this.terminal.terminal}; CLI exit ${exitCode}`);
      const quota = /quota|rate.?limit|usage.?limit|too many|429/i.test(reason);
      throw failure(reason, quota ? 'MUSE_SUBSCRIPTION_LIMIT' : 'MUSE_TURN_FAILED', quota ? 429 : 502);
    }
    if (typeof this.terminal.text !== 'string' || !this.terminal.text.trim()) throw failure('Muse completed without final text', 'MUSE_EMPTY_RESPONSE', 502);
    return { text: this.terminal.text, model: this.expectedModel, sessionId: this.sessionId };
  }
}

export async function runMuse(job, config, { signal, onText, onEvent, onActivity, onUsage } = {}) {
  if (!subscriptionStatus(config.authPath).ready) throw failure('Muse subscription login is required; complete muse login in a private local flow. No API-key fallback was attempted.', 'MUSE_SUBSCRIPTION_AUTH_REQUIRED', 503);
  if (signal?.aborted) throw failure('Request cancelled', 'MUSE_CANCELLED', 499);
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(config.stateDir, 'request-'));
  fs.chmodSync(dir, 0o700);
  try {
  const cfgDir = path.join(dir, 'config', 'muse');
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  // Link only the official CLI's opaque metadata file. Tokens stay in Keychain;
  // this gateway never opens Keychain or exports a subscription credential.
  fs.symlinkSync(config.authPath, path.join(cfgDir, 'auth.json'));
  const proxyEnv = { OPENCLAW_WORKSPACE: config.workspace, OPENCLAW_MCP_LOCAL_TOOL_MAX_TIMEOUT_MS: String(config.execTimeoutMs) };
  if (job.requesterSessionKey) proxyEnv.OPENCLAW_REQUESTER_SESSION_KEY = job.requesterSessionKey;
  const mcp = job.allowedTools.length ? { openclaw: {
    transport: 'stdio', command: process.execPath, args: [config.proxyPath], mode: 'required',
    env: { ...proxyEnv, OPENCLAW_MCP_ENABLED_TOOLS: job.allowedTools.join(',') },
  } } : {};
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ schema_version: 1, provider: 'meta', model: job.model, mcp_servers: mcp }), { mode: 0o600 });
  const promptPath = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptPath, job.prompt, { mode: 0o600 });
  const args = ['exec', '--json', '--model', job.model, '--reasoning-effort', job.effort,
    '--workspace', cwd, '--prompt-file', promptPath, '--no-foreign-personal-context',
    '--disable-write', '--disable-shell', '--disable-web-tools', '--approval-mode', 'never',
    '--max-model-steps', String(config.maxSteps)];
  for (const [index, image] of job.images.entries()) {
    const imagePath = path.join(dir, `image-${index + 1}.${image.extension}`);
    fs.writeFileSync(imagePath, image.bytes, { mode: 0o600 });
    args.push('--image', imagePath);
  }
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const env = { ...process.env, XDG_CONFIG_HOME: path.dirname(cfgDir), XDG_DATA_HOME: dataDir, MUSE_AUTH_PATH: config.authPath, MUSE_NO_AUTO_UPDATE: '1', ...proxyEnv };
  // Subscription-only: environmental API keys must never override device login.
  delete env.META_API_KEY;
  delete env.MODEL_API_KEY;
  delete env.MUSE_TRANSPORT_TRACE;
  delete env.OPENCLAW_REQUESTER_SESSION_KEY;
  if (job.requesterSessionKey) env.OPENCLAW_REQUESTER_SESSION_KEY = job.requesterSessionKey;
  let child;
    return await new Promise((resolve, reject) => {
      child = spawn(config.cliBin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8');
      let buffer = '', stderr = '', terminalError = null, settled = false, killTimer, lingerTimer;
      let lastActivity = Date.now();
      const kill = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
      const stop = (error) => {
        terminalError ??= error;
        kill('SIGTERM');
        killTimer ??= setTimeout(() => kill('SIGKILL'), 2000);
        killTimer.unref();
      };
      const abort = () => stop(failure('Request cancelled', 'MUSE_CANCELLED', 499));
      const parser = new MuseEvents({ onText, onEvent, onActivity, onTerminal: () => {
        // The CLI should exit after the terminal. Reap a lingering process,
        // but never reinterpret a killed/incomplete request as success.
        lingerTimer = setTimeout(() => stop(failure('Muse did not exit after its terminal result', 'MUSE_EXIT_TIMEOUT', 502)), config.exitGraceMs);
        lingerTimer.unref();
      } }, job.model);
      const timeout = setTimeout(() => stop(failure('Muse request timed out', 'MUSE_TIMEOUT', 504)), config.timeoutMs);
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > config.stallMs) stop(failure('Muse stream stalled', 'MUSE_STALL', 504));
      }, Math.min(config.stallMs, 5000));
      timeout.unref(); watchdog.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(lingerTimer); clearInterval(watchdog);
        signal?.removeEventListener('abort', abort);
        kill('SIGKILL'); // no orphaned MCP children after the CLI exits
        let accounting;
        try {
          accounting = collectUsage(path.join(dataDir, 'muse/sessions'), { rootRunId: parser.runId, rootSessionId: parser.sessionId, expectedPromptBytes: Buffer.byteLength(job.prompt) });
          onUsage?.(accounting);
          if (!error && !accounting.input.verified) error = failure('Prompt exceeds the verified CLI input boundary or was compacted before inference; incomplete input was not returned as success', 'MUSE_INPUT_NOT_PRESERVED', 413);
          if (value) value = { ...value, accounting, usage: accounting.usage ?? undefined };
        } catch (e) {
          if (!error) error = failure('Unable to verify Muse input/usage journal: ' + sanitizeError(e.message), 'MUSE_JOURNAL_ERROR', 502);
        }
        error ? reject(error) : resolve(value);
      };
      const line = text => {
        if (!text.trim()) return;
        try { parser.accept(JSON.parse(text)); }
        catch (e) { stop(e.code ? e : failure('Invalid Muse JSONL output', 'MUSE_PROTOCOL_ERROR', 502)); }
      };
      child.stdout.on('data', chunk => {
        lastActivity = Date.now(); buffer += decoder.write(chunk);
        if (buffer.length > 16 * 1024 ** 2) return stop(failure('Muse output record exceeds limit', 'MUSE_OUTPUT_LIMIT', 502));
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) { const part = buffer.slice(0, i); buffer = buffer.slice(i + 1); line(part); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
      child.stdout.on('error', e => stop(e)); child.stderr.on('error', e => stop(e));
      child.on('error', e => finish(failure(sanitizeError(e.message), 'MUSE_LAUNCH_FAILED', 502)));
      child.on('close', code => {
        buffer += decoder.end(); if (buffer.trim()) line(buffer);
        if (terminalError) return finish(terminalError);
        try { finish(null, parser.result(code)); }
        catch (e) {
          if (!parser.terminal && stderr) e.message += ': ' + sanitizeError(stderr);
          finish(e);
        }
      });
    });
  } finally {
    // dir is the exact private mkdtemp path created above; no user path is removed.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
