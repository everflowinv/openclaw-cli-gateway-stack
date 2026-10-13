import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectUsage, normalizeUsage } from './usage.mjs';
import { MODEL, CONTRIBUTOR_MODEL, WONDER_MODEL, WONDER_FULL_MODEL, listPriceCost } from './catalog.mjs';

test('Meta cache and reasoning remain subsets; malformed measurements are not zero-filled', () => {
  const u = normalizeUsage({ input_tokens: 18442, output_tokens: 33, cached_tokens: 12529, reasoning_tokens: 16 });
  assert.equal(u.total_tokens, 18475);
  assert.equal(u.completion_tokens, 33);
  assert.equal(u.prompt_tokens_details.cached_tokens, 12529);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 20 }), null);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 20, cached_tokens: 11, reasoning_tokens: 0 }), null);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 20, cached_tokens: 0, reasoning_tokens: 21 }), null);
  assert.equal(normalizeUsage({ input_tokens: -1, output_tokens: 20, cached_tokens: 0, reasoning_tokens: 0 }), null);
});
test('list-price estimates follow each model, with no long-context multiplier', () => {
  const u = normalizeUsage({ input_tokens: 1000000, output_tokens: 1000000, cached_tokens: 500000, reasoning_tokens: 700000 });
  assert.equal(listPriceCost(MODEL, u), 4.95);
  assert.ok(Math.abs(listPriceCost(CONTRIBUTOR_MODEL, u) - .251) < 1e-12);
  assert.equal(listPriceCost(WONDER_MODEL, u), 22.1);
  assert.equal(listPriceCost(WONDER_FULL_MODEL, u), null);
  assert.equal(listPriceCost('unknown', u), null);
});
test('journal mirror duplicates and attribution aliases do not double count; observers stay attributable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-usage-test-'));
  const record = (id, run, event) => ({ id: 'wrapper-'+id, stream: { id: run }, payload: { run_id: run, source_run_record_id: id, event } });
  const main = record('origin-main', 'root', { kind: 'model_completed', model: MODEL, usage: { input_tokens: 18442, output_tokens: 33, cached_tokens: 12529, reasoning_tokens: 16 } });
  const child = record('origin-child', 'child', { kind: 'model_completed', model: CONTRIBUTOR_MODEL, usage: { input_tokens: 3182, output_tokens: 1882, cached_tokens: 2801, reasoning_tokens: 1685 } });
  const trace = record('trace', 'root', { kind: 'model_input_trace_recorded', scope: 'full_request', model_step: 0, bounded: { current_user_message_bytes: 1004, total_lane_bytes: 49000 } });
  try {
    fs.writeFileSync(path.join(root, 'session.jsonl'), [trace, main, main, child, record('alias', 'root', { kind: 'goal_usage_attribution', record: { quantity: { input_tokens: 18442 } } })].map(JSON.stringify).join('\n'));
    fs.mkdirSync(path.join(root, 'subagent'));
    fs.writeFileSync(path.join(root, 'subagent/session.jsonl'), JSON.stringify(child));
    const result = collectUsage(root, { rootRunId: 'root', expectedPromptBytes: 1000 });
    assert.equal(result.calls.length, 2);
    assert.equal(result.usage.total_tokens, 23539);
    assert.equal(result.main.total_tokens, 18475);
    assert.equal(result.background.total_tokens, 5064);
    assert.equal(result.input.verified, true);
    assert.equal(collectUsage(root, { rootRunId: 'root', expectedPromptBytes: 1500 }).input.verified, false);
    assert.equal(collectUsage(root, { rootRunId: 'missing', expectedPromptBytes: 1000 }).input.verified, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('context usage uses first foreground input and foreground output, while billing counts all calls', async () => {
  const { contextUsage } = await import('./usage.mjs');
  const call = (scope, input, output) => ({ scope, usage: normalizeUsage({ input_tokens: input, output_tokens: output, cached_tokens: 0, reasoning_tokens: 0 }) });
  const usage = contextUsage([call('background', 5000, 200), call('main', 1000, 30), call('main', 1100, 50)]);
  assert.equal(usage.prompt_tokens, 1000);
  assert.equal(usage.completion_tokens, 80);
  assert.equal(usage.total_tokens, 1080);
  assert.equal(contextUsage([call('background', 5000, 200)]), null);
  assert.equal(contextUsage([{...call('main', 1100, 50), sequence: 20}, {...call('main', 1000, 30), sequence: 10}]).prompt_tokens, 1000);
});
