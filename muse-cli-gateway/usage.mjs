import fs from 'node:fs';
import path from 'node:path';
import { listPriceCost } from './catalog.mjs';

export function normalizeUsage(raw) {
  const values = ['input_tokens', 'output_tokens', 'cached_tokens', 'reasoning_tokens'].map(k => raw?.[k]);
  if (values.some(v => !Number.isSafeInteger(v) || v < 0)) return null;
  const [input, output, cached, reasoning] = values;
  if (cached > input || reasoning > output || input + output === 0) return null;
  // Meta documents cache as an input subset and reasoning as an output subset.
  return { prompt_tokens: input, prompt_tokens_details: { cached_tokens: cached }, completion_tokens: output,
    completion_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + output };
}
export function addUsage(items) {
  if (!items.length) return null;
  const raw = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
  for (const u of items) { raw.input_tokens += u.prompt_tokens; raw.output_tokens += u.completion_tokens; raw.cached_tokens += u.prompt_tokens_details.cached_tokens; raw.reasoning_tokens += u.completion_tokens_details.reasoning_tokens; }
  return normalizeUsage(raw);
}
export function sessionFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sessionFiles(file));
    else if (entry.isFile() && entry.name === 'session.jsonl') found.push(file);
    // Never follow symlinks into another request or the user's native sessions.
  }
  return found;
}

export function collectUsage(sessionsRoot, { rootRunId, rootSessionId, expectedPromptBytes = 0 } = {}) {
  const calls = [], seen = new Set(), traces = [];
  let invalidRecords = 0, parseErrors = 0;
  for (const file of sessionFiles(sessionsRoot)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { parseErrors++; continue; }
      const payload = record.payload, event = payload?.event;
      if (!event || typeof event !== 'object') continue;
      const runId = payload.run_id;
      const foreground = rootRunId ? runId === rootRunId : record.stream?.id === rootSessionId;
      if (event.kind === 'model_input_trace_recorded' && foreground && event.model_step === 0 && event.scope === 'full_request') {
        traces.push({ currentUserBytes: event.bounded?.current_user_message_bytes, totalLaneBytes: event.bounded?.total_lane_bytes });
      }
      if (event.kind !== 'model_completed') continue;
      const sourceId = payload.source_run_record_id ?? record.id;
      if (!sourceId || !runId) { invalidRecords++; continue; }
      const key = `${runId}:${sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const usage = normalizeUsage(event.usage);
      if (!usage) { invalidRecords++; continue; }
      const model = typeof event.model === 'string' ? event.model : null;
      calls.push({ id: key, model, sequence: payload.source_run_record_sequence ?? record.sequence ?? null, scope: foreground ? 'main' : 'background', usage, estimatedCostUsd: listPriceCost(model, usage) });
    }
  }
  const usage = addUsage(calls.map(c => c.usage));
  const first = traces[0];
  // First request must retain the whole supplied user message (which includes
  // OpenClaw's system/history framing). Later agent-loop compaction is separate.
  const inputVerified = Number.isSafeInteger(first?.currentUserBytes) && first.currentUserBytes >= expectedPromptBytes;
  return {
    schema: 'muse-session-reported-v1', usage, calls,
    contextUsage: contextUsage(calls),
    main: addUsage(calls.filter(c => c.scope === 'main').map(c => c.usage)),
    background: addUsage(calls.filter(c => c.scope !== 'main').map(c => c.usage)),
    estimatedCostUsd: calls.length && calls.every(c => c.estimatedCostUsd !== null) ? calls.reduce((n, c) => n + c.estimatedCostUsd, 0) : null,
    coverage: { reportedCalls: calls.length, invalidRecords, parseErrors, includesBackground: true, basis: 'reported-completed-model-calls' },
    input: { verified: inputVerified, expectedPromptBytes, currentUserBytes: first?.currentUserBytes ?? null, totalLaneBytes: first?.totalLaneBytes ?? null },
  };
}

// OpenClaw uses prompt_tokens to size the next request's context. Repeated
// tool-loop inputs and background observers belong only in billing totals.
export function contextUsage(calls) {
  const main = calls.filter(c => c.scope === 'main').sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity)).map(c => c.usage);
  if (!main.length) return null;
  const first = main[0], total = addUsage(main);
  if (!total) return null;
  return { ...first, completion_tokens: total.completion_tokens,
    completion_tokens_details: total.completion_tokens_details,
    total_tokens: first.prompt_tokens + total.completion_tokens };
}
